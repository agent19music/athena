import hashlib
import json
import os
import re
from pathlib import Path

import httpx
from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter
from sqlalchemy.sql import func

from database import DocumentChunk, get_session, session_for_org
from embeddings import embed_documents

USE_MOCK = os.getenv("USE_MOCK", "false").lower() == "true"
SAMPLE_DOCS_PATH = Path(__file__).parent / "sample_docs"

# Comma-separated Google Doc IDs or full URLs, e.g.:
# PUBLIC_DOC_IDS=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms,https://docs.google.com/document/d/abc123/edit
_PUBLIC_DOC_IDS_RAW = os.getenv("PUBLIC_DOC_IDS", "")


def _parse_doc_id(id_or_url: str) -> str:
    """Extract doc ID from a full Google Docs URL or return the ID as-is."""
    match = re.search(r"/document/d/([a-zA-Z0-9_-]+)", id_or_url)
    return match.group(1) if match else id_or_url.strip()


def namespaced_doc_id(source_type: str, org_id: str, provider_id: str) -> str:
    """Namespace a source's native document id per org: {source}:{org}:{id}.

    Two tenants ingesting the same public Google Doc or Notion page share the
    provider's id. The `org_id` column + RLS isolate the rows themselves, but
    the delete-then-insert upsert keys on `doc_id`, so an un-namespaced id lets
    a re-ingest in one org delete another org's chunks for the same provider id
    (and makes doc_id ambiguous across tenants). Namespacing keeps each tenant's
    document set distinct while remaining deterministic, so re-ingest still
    replaces exactly that org's chunks.
    """
    return f"{source_type}:{org_id}:{provider_id}"


HEADERS_TO_SPLIT_ON = [
    ("#", "h1"),
    ("##", "h2"),
    ("###", "h3"),
]

# Header split gives us document structure; the recursive splitter then bounds
# each section so a header-less export (typical of Google Docs / Drive plain-text)
# never becomes one giant chunk that blows the embedding input limit.
# Sizes are in characters — ~4 chars/token, so ~3000 chars ≈ ~750 tokens, well
# under the embedding model's input cap, with overlap to preserve context across cuts.
CHUNK_SIZE_CHARS = int(os.getenv("CHUNK_SIZE_CHARS", "3000"))
CHUNK_OVERLAP_CHARS = int(os.getenv("CHUNK_OVERLAP_CHARS", "400"))

header_splitter = MarkdownHeaderTextSplitter(
    headers_to_split_on=HEADERS_TO_SPLIT_ON,
    strip_headers=False,
)

recursive_splitter = RecursiveCharacterTextSplitter(
    chunk_size=CHUNK_SIZE_CHARS,
    chunk_overlap=CHUNK_OVERLAP_CHARS,
    separators=["\n\n", "\n", ". ", " ", ""],
)


# ---------------------------------------------------------------------------
# Source loaders
# ---------------------------------------------------------------------------

def load_from_local(path: Path) -> list[dict]:
    docs = []
    for md_file in path.glob("*.md"):
        content = md_file.read_text(encoding="utf-8")
        docs.append({
            "doc_id": md_file.stem,
            "title": md_file.stem.replace("_", " ").title(),
            "content": content,
            "source_type": "mock",
        })
    return docs


def load_from_public_gdocs(doc_ids_raw: str) -> list[dict]:
    """
    Fetch publicly shared Google Docs by ID or URL — no auth required.
    Docs must be shared as 'Anyone with the link can view'.
    Fetches plain-text export and treats it as markdown for chunking.
    """
    ids = [_parse_doc_id(entry) for entry in doc_ids_raw.split(",") if entry.strip()]
    docs = []

    with httpx.Client(follow_redirects=True, timeout=30) as client:
        for doc_id in ids:
            url = f"https://docs.google.com/document/d/{doc_id}/export?format=txt"
            resp = client.get(url)
            resp.raise_for_status()
            content = resp.text

            # Use first non-empty line as title fallback
            first_line = next((ln.lstrip("# ").strip() for ln in content.splitlines() if ln.strip()), doc_id)

            docs.append({
                "doc_id": doc_id,
                "title": first_line,
                "content": content,
                "source_type": "google_docs",
            })
            print(f"  Fetched public doc '{first_line}' ({doc_id})")

    return docs


def load_from_google_drive(folder_id: str, service_account_json: str) -> list[dict]:
    """
    Production path — activate by setting USE_MOCK=false + env vars.
    """
    from google.oauth2 import service_account as sa
    from googleapiclient.discovery import build

    creds_info = json.loads(service_account_json)
    creds = sa.Credentials.from_service_account_info(
        creds_info,
        scopes=["https://www.googleapis.com/auth/drive.readonly"],
    )
    service = build("drive", "v3", credentials=creds)

    results = service.files().list(
        q=(
            f"'{folder_id}' in parents "
            "and mimeType='application/vnd.google-apps.document' "
            "and trashed=false"
        ),
        fields="files(id, name, modifiedTime)",
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()

    docs = []
    for file in results.get("files", []):
        content = service.files().export(
            fileId=file["id"],
            mimeType="text/plain",
        ).execute()
        docs.append({
            "doc_id": file["id"],
            "title": file["name"],
            "content": content.decode("utf-8"),
            "source_type": "google_docs",
        })

    return docs


# ---------------------------------------------------------------------------
# Notion loader
# ---------------------------------------------------------------------------

_NOTION_API_KEY = os.getenv("NOTION_API_KEY", "")
_NOTION_ROOT_PAGE_ID = os.getenv("NOTION_ROOT_PAGE_ID", "")


def _notion_headers(api_key: str) -> dict:
    return {
        "Authorization": f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }


def _notion_blocks_to_markdown(blocks: list[dict]) -> str:
    """Convert Notion block objects to markdown text."""
    lines: list[str] = []
    for block in blocks:
        btype = block.get("type", "")
        data = block.get(btype, {})
        rich_texts = data.get("rich_text", [])
        text = "".join(rt.get("plain_text", "") for rt in rich_texts)

        if btype == "heading_1":
            lines.append(f"# {text}")
        elif btype == "heading_2":
            lines.append(f"## {text}")
        elif btype == "heading_3":
            lines.append(f"### {text}")
        elif btype == "paragraph":
            lines.append(text)
        elif btype == "bulleted_list_item":
            lines.append(f"- {text}")
        elif btype == "numbered_list_item":
            lines.append(f"1. {text}")
        elif btype == "to_do":
            checked = data.get("checked", False)
            marker = "x" if checked else " "
            lines.append(f"- [{marker}] {text}")
        elif btype == "toggle":
            lines.append(f"**{text}**")
        elif btype == "code":
            lang = data.get("language", "")
            lines.append(f"```{lang}\n{text}\n```")
        elif btype == "quote":
            lines.append(f"> {text}")
        elif btype == "callout":
            lines.append(f"> {text}")
        elif btype == "divider":
            lines.append("---")
        elif text:
            lines.append(text)

    return "\n\n".join(lines)


def _notion_get_page_title(page: dict) -> str:
    """Extract the title from a Notion page object."""
    props = page.get("properties", {})
    for prop in props.values():
        if prop.get("type") == "title":
            title_parts = prop.get("title", [])
            return "".join(t.get("plain_text", "") for t in title_parts)
    return page.get("id", "Untitled")


def load_from_notion(api_key: str, root_page_id: str) -> list[dict]:
    """
    Fetch pages from Notion under a root page and convert to docs.
    The root page's children are treated as individual documents.
    """
    headers = _notion_headers(api_key)
    docs = []

    with httpx.Client(timeout=30) as client:
        # List child blocks of the root page to find sub-pages
        child_pages = []
        cursor = None
        while True:
            params = {"page_size": 100}
            if cursor:
                params["start_cursor"] = cursor
            resp = client.get(
                f"https://api.notion.com/v1/blocks/{root_page_id}/children",
                headers=headers,
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
            for block in data.get("results", []):
                if block.get("type") == "child_page":
                    child_pages.append(block["id"])
            if not data.get("has_more"):
                break
            cursor = data.get("next_cursor")

        # If no child pages, treat the root page itself as the document
        page_ids = child_pages if child_pages else [root_page_id]

        for page_id in page_ids:
            # Get page metadata for title
            page_resp = client.get(
                f"https://api.notion.com/v1/pages/{page_id}",
                headers=headers,
            )
            page_resp.raise_for_status()
            page_data = page_resp.json()
            title = _notion_get_page_title(page_data)

            # Fetch all blocks (content) for this page
            all_blocks = []
            cursor = None
            while True:
                params = {"page_size": 100}
                if cursor:
                    params["start_cursor"] = cursor
                blocks_resp = client.get(
                    f"https://api.notion.com/v1/blocks/{page_id}/children",
                    headers=headers,
                    params=params,
                )
                blocks_resp.raise_for_status()
                blocks_data = blocks_resp.json()
                all_blocks.extend(blocks_data.get("results", []))
                if not blocks_data.get("has_more"):
                    break
                cursor = blocks_data.get("next_cursor")

            content = _notion_blocks_to_markdown(all_blocks)

            docs.append({
                "doc_id": page_id,
                "title": title,
                "content": content,
                "source_type": "notion",
            })
            print(f"  Fetched Notion page '{title}' ({page_id})")

    return docs


# ---------------------------------------------------------------------------
# Tally loader — form feedback / survey responses
# ---------------------------------------------------------------------------

_TALLY_API_KEY = os.getenv("TALLY_API_KEY", "")
_TALLY_FORM_IDS_RAW = os.getenv("TALLY_FORM_IDS", "")


def _tally_headers(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


def _tally_answer_text(value) -> str:
    """Flatten a Tally answer (string, number, or a choice list/dict) to plain text."""
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return ", ".join(t for t in (_tally_answer_text(v) for v in value) if t)
    if isinstance(value, dict):
        return str(value.get("text") or value.get("label") or value.get("name") or value)
    return str(value)


# Tally's question types, normalised to the buckets the aggregates key off.
# Verified against a live form: DROPDOWN/MULTIPLE_CHOICE/CHECKBOXES answer with
# a list of resolved *labels* (not ids), LINEAR_SCALE with a bare number,
# INPUT_TEXT/TEXTAREA with a string, MATRIX with {row_id: [labels]}.
# Anything unrecognised falls to "other" and is still stored via raw_value.
_TALLY_KIND_BY_TYPE = {
    "INPUT_TEXT": "short_text",
    "INPUT_EMAIL": "short_text",
    "INPUT_LINK": "short_text",
    "INPUT_PHONE_NUMBER": "short_text",
    "TEXTAREA": "long_text",
    "INPUT_NUMBER": "number",
    "LINEAR_SCALE": "rating",
    "RATING": "rating",
    "DROPDOWN": "choice",
    "MULTIPLE_CHOICE": "choice",
    "CHECKBOXES": "choice",
    "MULTI_SELECT": "choice",
    "RANKING": "choice",
    "INPUT_DATE": "date",
    "INPUT_TIME": "date",
    "MATRIX": "matrix",
}

# Kinds whose text is embedded for semantic search / theme clustering. Choice and
# numeric answers are counted with GROUP BY, so embedding them buys nothing.
EMBEDDABLE_KINDS = {"short_text", "long_text"}


def _normalise_tally_answer(kind: str, value) -> dict:
    """Project one Tally answer onto the typed columns, keeping the raw payload.

    Exactly one typed column is normally populated; raw_value always is, so a
    shape we normalise imperfectly today is never lost.
    """
    out = {
        "answer_text": None,
        "answer_numeric": None,
        "answer_choices": None,
        "raw_value": value,
    }

    if value is None or value == "" or value == []:
        return out

    if kind in ("short_text", "long_text", "date"):
        out["answer_text"] = _tally_answer_text(value)
    elif kind in ("number", "rating"):
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out["answer_numeric"] = value
        else:
            # Ratings occasionally arrive as a one-element list or a string.
            text_value = _tally_answer_text(value)
            try:
                out["answer_numeric"] = float(text_value)
            except (TypeError, ValueError):
                out["answer_text"] = text_value
    elif kind == "choice":
        choices = value if isinstance(value, list) else [value]
        out["answer_choices"] = [c for c in (_tally_answer_text(v) for v in choices) if c]
    elif kind == "matrix":
        # {row_id: [column labels]} — flattened to choices for counting, with the
        # per-row detail preserved in raw_value.
        if isinstance(value, dict):
            flat = []
            for picks in value.values():
                flat.extend(c for c in (_tally_answer_text(v) for v in (picks or [])) if c)
            out["answer_choices"] = flat
        else:
            out["answer_text"] = _tally_answer_text(value)
    else:
        out["answer_text"] = _tally_answer_text(value)

    return out


def _tally_structured(
    form_id: str, form_name: str, questions: list[dict], submission: dict, doc_id: str
) -> dict:
    """The submission as rows rather than prose — see the form_structured_store
    migration for why both are written."""
    meta = {
        (q.get("id") or q.get("uuid")): {
            "kind": _TALLY_KIND_BY_TYPE.get(q.get("type", ""), "other"),
            "raw_type": q.get("type"),
            "label": q.get("title", ""),
            "position": i,
        }
        for i, q in enumerate(questions)
    }

    answers = []
    for response in submission.get("responses", []):
        question_id = response.get("questionId", "")
        if not question_id:
            continue
        info = meta.get(question_id, {"kind": "other", "raw_type": None, "label": question_id, "position": None})
        value = response.get("answer", response.get("value"))
        answers.append({
            "question_id": question_id,
            "kind": info["kind"],
            **_normalise_tally_answer(info["kind"], value),
        })

    return {
        "form_id": form_id,
        "form_name": form_name,
        "external_id": submission.get("id", ""),
        "respondent_id": submission.get("respondentId"),
        "submitted_at": submission.get("submittedAt"),
        "is_completed": submission.get("isCompleted"),
        "doc_id": doc_id,
        "questions": [
            {"question_id": qid, **info} for qid, info in meta.items()
        ],
        "answers": answers,
    }


def _tally_submission_to_doc(form_id: str, form_name: str, questions: list[dict], submission: dict) -> dict:
    """One document per submission — keeps a single respondent's feedback intact
    for retrieval instead of fragmenting it into a chunk per question.

    Also carries a `structured` payload built from the same API response, so the
    row-level store is populated without a second round trip to Tally.
    """
    question_labels = {(q.get("id") or q.get("uuid")): q.get("title", "") for q in questions}

    lines = [f"Form: {form_name}", f"Submitted: {submission.get('submittedAt', '')}", ""]
    for response in submission.get("responses", []):
        question_id = response.get("questionId", "")
        label = question_labels.get(question_id, question_id or "Question")
        answer = _tally_answer_text(response.get("answer", response.get("value")))
        if not answer:
            continue
        lines.append(f"**{label}**")
        lines.append(answer)
        lines.append("")

    submission_id = submission.get("id", "")
    doc_id = f"{form_id}_{submission_id}" if submission_id else form_id
    return {
        "doc_id": doc_id,
        "title": f"{form_name} — response {submission_id[:8]}" if submission_id else f"{form_name} response",
        "content": "\n".join(lines).strip(),
        "source_type": "tally",
        "structured": _tally_structured(form_id, form_name, questions, submission, doc_id),
    }


def load_from_tally(api_key: str, form_ids_raw: str) -> list[dict]:
    """
    Fetch submissions for each configured Tally form (tally.so) via the REST API.
    Each submission becomes one document so a respondent's answers stay together.
    """
    form_ids = [f.strip() for f in form_ids_raw.split(",") if f.strip()]
    headers = _tally_headers(api_key)
    docs = []

    with httpx.Client(timeout=30) as client:
        for form_id in form_ids:
            form_resp = client.get(f"https://api.tally.so/forms/{form_id}", headers=headers)
            form_resp.raise_for_status()
            form_name = form_resp.json().get("name", form_id)

            fetched = 0
            page = 1
            while True:
                resp = client.get(
                    f"https://api.tally.so/forms/{form_id}/submissions",
                    headers=headers,
                    params={"page": page, "limit": 50},
                )
                resp.raise_for_status()
                data = resp.json()

                questions = data.get("questions", [])

                for submission in data.get("submissions", []):
                    if not submission.get("responses"):
                        continue
                    docs.append(_tally_submission_to_doc(form_id, form_name, questions, submission))
                    fetched += 1

                if not data.get("hasMore"):
                    break
                page += 1

            print(f"  Fetched {fetched} Tally submissions for form '{form_name}' ({form_id})")

    return docs


# ---------------------------------------------------------------------------
# Multi-source document loading
# ---------------------------------------------------------------------------

def load_documents(
    notion_api_key: str | None = None,
    notion_root_page_id: str | None = None,
    public_doc_ids: list[str] | None = None,
    drive_folder_id: str | None = None,
    tally_api_key: str | None = None,
    tally_form_ids: list[str] | None = None,
) -> list[dict]:
    """Load documents from all configured sources (additive, not exclusive).

    Per-request overrides (from onboarding form) take precedence over env vars.
    """
    docs = []

    # Source 1: Public Google Docs — per-request list takes precedence over env var
    effective_public_ids = ",".join(public_doc_ids) if public_doc_ids else _PUBLIC_DOC_IDS_RAW
    if effective_public_ids.strip():
        print("PUBLIC_DOC_IDS set — fetching public Google Docs")
        docs += load_from_public_gdocs(effective_public_ids)

    # Source 2: Notion — per-request credentials take precedence over env vars
    effective_notion_key = notion_api_key or _NOTION_API_KEY
    effective_notion_root = notion_root_page_id or _NOTION_ROOT_PAGE_ID
    if effective_notion_key and effective_notion_root:
        print(f"NOTION_API_KEY set — fetching from Notion root page {effective_notion_root}")
        docs += load_from_notion(effective_notion_key, effective_notion_root)

    # Source 3: Tally — per-request key + form ids take precedence over env vars
    effective_tally_key = tally_api_key or _TALLY_API_KEY
    effective_tally_forms = ",".join(tally_form_ids) if tally_form_ids else _TALLY_FORM_IDS_RAW
    if effective_tally_key and effective_tally_forms.strip():
        print(f"TALLY_API_KEY set — fetching submissions for forms {effective_tally_forms}")
        docs += load_from_tally(effective_tally_key, effective_tally_forms)

    # Source 4: Google Drive (service account). Per-org folder takes precedence
    # over the deployment-wide DRIVE_FOLDER_ID; the service-account JSON is always
    # a deployment secret shared across tenants (each org shares its folder with it).
    effective_folder = drive_folder_id or os.getenv("DRIVE_FOLDER_ID")
    service_account_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
    if effective_folder and service_account_json:
        print(f"Loading from Google Drive folder {effective_folder}")
        docs += load_from_google_drive(effective_folder, service_account_json)

    # Source 5: Local mock files (fallback or augmentation)
    if USE_MOCK:
        print("USE_MOCK=true — augmenting with sample_docs/")
        docs += load_from_local(SAMPLE_DOCS_PATH)

    if not docs:
        raise EnvironmentError(
            "No document sources configured. Set PUBLIC_DOC_IDS, NOTION_API_KEY + "
            "NOTION_ROOT_PAGE_ID, TALLY_API_KEY + TALLY_FORM_IDS, DRIVE_FOLDER_ID + "
            "GOOGLE_SERVICE_ACCOUNT_JSON, or USE_MOCK=true."
        )

    return docs


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

def _header_breadcrumb(metadata: dict) -> str:
    """Join whatever header levels a section carries into 'H1 › H2 › H3'."""
    parts = [metadata.get(level) for level in ("h1", "h2", "h3")]
    return " › ".join(p for p in parts if p)


def chunk_document(doc: dict) -> list[dict]:
    """
    Two-pass chunking: split on markdown headers for structure, then bound each
    section with the recursive splitter so no chunk exceeds the size cap. Each
    resulting chunk carries its header breadcrumb (for citations) and is prefixed
    with that breadcrumb so an isolated chunk still reads with context.
    """
    sections = header_splitter.split_text(doc["content"])

    out: list[dict] = []
    chunk_index = 0  # document-wide order, unlike section_part (resets per section) —
    # lets a preview reassemble a document's full text in original reading order.
    for section in sections:
        breadcrumb = _header_breadcrumb(section.metadata)
        pieces = recursive_splitter.split_text(section.page_content)

        for i, piece in enumerate(pieces):
            text = piece.strip()
            if not text:
                continue
            # Prefix the breadcrumb only when the piece doesn't already start
            # with the header text (first piece of a strip_headers=False section).
            if breadcrumb and not text.startswith(breadcrumb.split(" › ")[-1]):
                chunk_text = f"{breadcrumb}\n\n{text}"
            else:
                chunk_text = text

            metadata = dict(section.metadata)
            metadata["breadcrumb"] = breadcrumb
            metadata["section_part"] = i
            metadata["chunk_index"] = chunk_index
            chunk_index += 1

            out.append({
                "doc_id": doc["doc_id"],
                "title": doc["title"],
                "chunk_text": chunk_text,
                "metadata": metadata,
                "source_type": doc.get("source_type", "mock"),
            })

    return out


# ---------------------------------------------------------------------------
# Main ingestion entry point
# ---------------------------------------------------------------------------

def _answer_hash(text_value: str) -> str:
    return hashlib.sha256(text_value.encode("utf-8")).hexdigest()


async def persist_form_submissions(org_id: str, docs: list[dict]) -> dict:
    """Write form submissions as rows alongside the text chunks already stored.

    Additive to retrieval: `documents` is untouched here, so RAG behaves exactly
    as before. What this buys is countable data — "how many chose X" becomes a
    GROUP BY instead of an inference from a top-k sample.

    Embeddings are computed only for free-text answers, and only for text whose
    hash is not already stored for this org, so a re-sync of an unchanged form
    embeds nothing. Repeated answers ("Yes", "npm") embed once and are reused.
    """
    from database import FormAnswer, FormDefinition, FormQuestion, FormResponse

    submissions = [d["structured"] for d in docs if d.get("structured")]
    if not submissions:
        return {"forms": 0, "responses": 0, "answers": 0, "embedded": 0}

    # ---- forms + questions -------------------------------------------------
    forms: dict[str, str] = {}          # form_id -> name
    questions: dict[tuple[str, str], dict] = {}
    for sub in submissions:
        forms[sub["form_id"]] = sub["form_name"]
        for q in sub["questions"]:
            questions[(sub["form_id"], q["question_id"])] = q

    # ---- embedding cache: existing hashes for this org ---------------------
    free_text: dict[str, str] = {}      # hash -> text, for answers needing a vector
    for sub in submissions:
        for a in sub["answers"]:
            if a["kind"] in EMBEDDABLE_KINDS and a["answer_text"]:
                free_text[_answer_hash(a["answer_text"])] = a["answer_text"]

    known: dict[str, list[float]] = {}
    if free_text:
        with session_for_org(org_id) as session:
            rows = (
                session.query(FormAnswer.text_hash, FormAnswer.embedding)
                .filter(
                    FormAnswer.org_id == org_id,
                    FormAnswer.text_hash.in_(list(free_text)),
                    FormAnswer.embedding.isnot(None),
                )
                .all()
            )
            for h, vec in rows:
                if h and vec is not None and h not in known:
                    known[h] = vec

    to_embed = [h for h in free_text if h not in known]
    if to_embed:
        print(f"  Embedding {len(to_embed)} new form answers ({len(known)} reused from cache)")
        vectors = await embed_documents([free_text[h] for h in to_embed])
        known.update(zip(to_embed, vectors))

    # ---- upsert ------------------------------------------------------------
    counts = {"forms": len(forms), "responses": 0, "answers": 0, "embedded": len(to_embed)}

    with session_for_org(org_id) as session:
        for form_id, name in forms.items():
            existing = session.query(FormDefinition).filter_by(org_id=org_id, form_id=form_id).first()
            if existing:
                existing.name = name
                existing.synced_at = func.now()
            else:
                session.add(FormDefinition(org_id=org_id, form_id=form_id, name=name, provider="tally"))

        existing_questions = {
            (q.form_id, q.question_id): q
            for q in session.query(FormQuestion).filter(FormQuestion.org_id == org_id).all()
        }

        # Embed a question's label once, so a chat query can later be matched to
        # the question it's about (see form_insights.match_form_question). Only
        # new questions and ones whose label changed or never got an embedding
        # pay for a re-embed — a form's question set rarely changes sync to sync.
        to_embed: dict[tuple[str, str], str] = {}
        for key, q in questions.items():
            existing = existing_questions.get(key)
            if q["label"] and (existing is None or existing.label != q["label"] or existing.embedding is None):
                to_embed[key] = q["label"]

        label_vectors: dict[tuple[str, str], list[float]] = {}
        if to_embed:
            keys = list(to_embed)
            vectors = await embed_documents([to_embed[k] for k in keys])
            label_vectors = dict(zip(keys, vectors))

        for key, q in questions.items():
            form_id, question_id = key
            existing = existing_questions.get(key)
            vector = label_vectors.get(key)
            if existing:
                existing.label = q["label"]
                existing.kind = q["kind"]
                existing.raw_type = q["raw_type"]
                existing.position = q["position"]
                if vector is not None:
                    existing.embedding = vector
            else:
                session.add(FormQuestion(
                    org_id=org_id, form_id=form_id, question_id=question_id,
                    label=q["label"], kind=q["kind"], raw_type=q["raw_type"], position=q["position"],
                    embedding=vector,
                ))
        session.commit()

    # Fresh session so SET LOCAL ROLE + athena.org_id are applied on begin.
    # Continuing after commit on the same session has dropped that scope in
    # production and FORCE RLS then rejects form_responses inserts.
    with session_for_org(org_id) as session:
        for sub in submissions:
            response = (
                session.query(FormResponse)
                .filter_by(org_id=org_id, form_id=sub["form_id"], external_id=sub["external_id"])
                .first()
            )
            if not response:
                response = FormResponse(
                    org_id=org_id, form_id=sub["form_id"], external_id=sub["external_id"]
                )
                session.add(response)

            response.respondent_id = sub["respondent_id"]
            response.submitted_at = sub["submitted_at"]
            response.is_completed = sub["is_completed"]
            response.doc_id = sub["doc_id"]
            session.flush()  # need response.id for the answer rows

            # Replace this submission's answers wholesale — a respondent editing
            # an answer must not leave the previous value behind.
            session.query(FormAnswer).filter_by(response_id=response.id).delete()

            for a in sub["answers"]:
                text_hash = (
                    _answer_hash(a["answer_text"])
                    if a["kind"] in EMBEDDABLE_KINDS and a["answer_text"]
                    else None
                )
                session.add(FormAnswer(
                    org_id=org_id,
                    response_id=response.id,
                    form_id=sub["form_id"],
                    question_id=a["question_id"],
                    kind=a["kind"],
                    answer_text=a["answer_text"],
                    answer_numeric=a["answer_numeric"],
                    answer_choices=a["answer_choices"],
                    raw_value=a["raw_value"],
                    embedding=known.get(text_hash) if text_hash else None,
                    text_hash=text_hash,
                ))
                counts["answers"] += 1

            counts["responses"] += 1

        # Response counts per form, now that the rows exist.
        for form_id in forms:
            total = session.query(FormResponse).filter_by(org_id=org_id, form_id=form_id).count()
            form = session.query(FormDefinition).filter_by(org_id=org_id, form_id=form_id).first()
            if form:
                form.response_count = total

        session.commit()

    print(
        f"  Structured store: {counts['forms']} forms, {counts['responses']} responses, "
        f"{counts['answers']} answers, {counts['embedded']} newly embedded"
    )
    return counts


def create_ingest_job(org_id: str, trigger: str = "manual") -> str:
    """Open a "running" ingest_jobs row and return its id.

    Split out of run_ingestion so POST /ingest can create the job *before*
    handing off to a background task, and return the id to the caller. Without
    that, a client has no handle to poll and can only guess when a sync
    finished — which is why the connections page used to need a hard refresh.

    Ensures the organizations FK target exists first — onboarding often hits
    /ingest for a brand-new Clerk org before any webhook/row upsert ran, and
    ingest_jobs.org_id has a NOT NULL FK to organizations.clerk_org_id.
    """
    from database import IngestJob, ensure_organization_exists
    ensure_organization_exists(org_id)
    with get_session() as session:
        job = IngestJob(org_id=org_id, status="running", trigger=trigger)
        session.add(job)
        session.commit()
        return str(job.id)


async def run_ingestion(
    org_id: str | None = None,
    org_name: str | None = None,
    org_logo_url: str | None = None,
    notion_api_key: str | None = None,
    notion_root_page_id: str | None = None,
    public_doc_ids: list[str] | None = None,
    drive_folder_id: str | None = None,
    tally_api_key: str | None = None,
    tally_form_ids: list[str] | None = None,
    tally_oauth_refresh_token: str | None = None,
    tally_oauth_expires_in: int | None = None,
    tally_oauth_scope: str | None = None,
    trigger: str = "manual",
    job_id: str | None = None,
) -> dict:
    # org_id is mandatory: chunks are tenant data and must never be written
    # unscoped. A missing org would otherwise create null-org rows visible to all.
    if not org_id:
        raise ValueError("run_ingestion requires an org_id")

    # Upsert org record (also the FK target that document chunks reference), and
    # capture the org's *stored* config to fall back on. A re-sync (e.g. the admin
    # "Sync now" button) sends only org_id — without this fallback it would ignore
    # the org's saved Notion key / doc ids / Drive folder and index nothing.
    from database import IngestJob, Organization
    with get_session() as session:
        org = session.query(Organization).filter_by(clerk_org_id=org_id).first()
        if org:
            if org_name:
                org.name = org_name
            if org_logo_url:
                org.logo_url = org_logo_url
            if notion_api_key:
                org.notion_api_key = notion_api_key
            if notion_root_page_id:
                org.notion_root_page_id = notion_root_page_id
            if public_doc_ids is not None:
                org.public_doc_ids = public_doc_ids
            if drive_folder_id is not None:
                org.drive_folder_id = drive_folder_id
            if tally_api_key:
                org.tally_api_key = tally_api_key
            if tally_form_ids is not None:
                org.tally_form_ids = tally_form_ids
            if tally_oauth_refresh_token:
                org.tally_oauth_refresh_token = tally_oauth_refresh_token
            if tally_oauth_scope:
                org.tally_oauth_scope = tally_oauth_scope
            if tally_oauth_expires_in and tally_oauth_expires_in > 0:
                from datetime import datetime, timedelta, timezone
                org.tally_oauth_expires_at = datetime.now(timezone.utc) + timedelta(
                    seconds=int(tally_oauth_expires_in)
                )
        else:
            org = Organization(
                clerk_org_id=org_id,
                name=org_name or "Unnamed Organisation",
                logo_url=org_logo_url,
                notion_api_key=notion_api_key,
                notion_root_page_id=notion_root_page_id,
                public_doc_ids=public_doc_ids or [],
                drive_folder_id=drive_folder_id,
                tally_api_key=tally_api_key,
                tally_form_ids=tally_form_ids or [],
            )
            session.add(org)
        session.commit()
        # Effective config: explicit per-request value wins, else the stored one.
        eff_notion_key = notion_api_key or org.notion_api_key
        eff_notion_root = notion_root_page_id or org.notion_root_page_id
        eff_public_ids = public_doc_ids if public_doc_ids is not None else org.public_doc_ids
        eff_drive_folder = drive_folder_id or org.drive_folder_id
        eff_tally_key = tally_api_key or org.tally_api_key
        eff_tally_forms = tally_form_ids if tally_form_ids is not None else org.tally_form_ids

        # Refresh OAuth access token when we have a refresh token on the org.
        if org and getattr(org, "tally_oauth_refresh_token", None):
            try:
                import tally_oauth
                fresh = tally_oauth.ensure_fresh_tally_token(org)
                session.commit()
                if fresh:
                    eff_tally_key = fresh
            except Exception as e:
                print(f"Tally OAuth refresh skipped/failed: {e}")

    # Open a job row so status is observable while the run is in flight. The
    # caller may have already created one (see create_ingest_job) so it could
    # hand a job id back to the client before this background task starts.
    if job_id is None:
        job_id = create_ingest_job(org_id, trigger)

    def _finish(status: str, *, documents: int = 0, chunks: int = 0, error: str | None = None):
        from sqlalchemy.sql import func as _func
        with get_session() as s:
            j = s.query(IngestJob).filter_by(id=job_id).first()
            if j:
                j.status = status
                j.documents = documents
                j.chunks = chunks
                j.error = error
                j.finished_at = _func.now()
                s.commit()

    try:
        docs = load_documents(
            notion_api_key=eff_notion_key,
            notion_root_page_id=eff_notion_root,
            public_doc_ids=eff_public_ids,
            drive_folder_id=eff_drive_folder,
            tally_api_key=eff_tally_key,
            tally_form_ids=eff_tally_forms,
        )
        print(f"Loaded {len(docs)} documents.")

        # Namespace each doc's id per org so identical provider docs (the same public
        # Google Doc or Notion page across tenants) never collide on doc_id.
        for doc in docs:
            doc["doc_id"] = namespaced_doc_id(doc["source_type"], org_id, doc["doc_id"])
            # Loaders build the structured payload before namespacing (they have
            # no org context), so carry the final id across — otherwise
            # form_responses.doc_id points at an id `documents` never stores.
            if doc.get("structured"):
                doc["structured"]["doc_id"] = doc["doc_id"]

        all_chunks = []
        for doc in docs:
            all_chunks.extend(chunk_document(doc))

        print(f"Produced {len(all_chunks)} chunks. Embedding and upserting...")

        # Embed all chunks up front — batched + retried inside embed_documents.
        embeddings = await embed_documents([c["chunk_text"] for c in all_chunks])

        # Delete-then-insert is always org-scoped; RLS on the scoped session enforces
        # this at the DB even if the explicit filter were dropped.
        seen_docs: set[str] = set()
        with session_for_org(org_id) as session:
            upserted = 0
            for chunk, embedding in zip(all_chunks, embeddings):
                # Clear a doc's old chunks once, on first sighting, not per chunk.
                if chunk["doc_id"] not in seen_docs:
                    session.query(DocumentChunk).filter_by(
                        doc_id=chunk["doc_id"], org_id=org_id
                    ).delete()
                    seen_docs.add(chunk["doc_id"])

                session.add(DocumentChunk(
                    org_id=org_id,
                    doc_id=chunk["doc_id"],
                    title=chunk["title"],
                    chunk_text=chunk["chunk_text"],
                    embedding=embedding,
                    metadata_=chunk["metadata"],
                    source_type=chunk["source_type"],
                ))
                upserted += 1

            session.commit()

        # Dual-write: the same submissions again as rows, for aggregates. Kept
        # after the chunk commit so a failure here cannot cost the RAG index.
        # A raised error used to fail the whole job and dump the SQL into the UI.
        try:
            form_stats = await persist_form_submissions(org_id, docs)
        except Exception as exc:
            import sentry_sdk
            sentry_sdk.capture_exception(exc)
            print(f"Form store failed (chunks kept): {type(exc).__name__}: {str(exc)[:400]}")
            form_stats = {"responses": 0}

        # Themes over the free text that just landed. Isolated because it calls
        # the LLM: a labelling or quota failure must leave the ingest completed,
        # since the chunks and structured rows are already durable.
        if form_stats["responses"]:
            try:
                from themes import recompute_themes
                await recompute_themes(org_id)
            except Exception as exc:  # noqa: BLE001
                print(f"Theme extraction failed (ingest still succeeded): {exc}")
    except Exception as exc:
        # Re-raise so Sentry records it once. The print is what Render logs
        # retain; the database keeps the raw string and the API shortens it.
        print(f"Ingest failed for {org_id}: {type(exc).__name__}: {str(exc)[:400]}")
        _finish("failed", error=str(exc))
        raise

    _finish("completed", documents=len(docs), chunks=upserted)
    print(f"Ingestion complete. {upserted} chunks stored.")
    return {"status": "ok", "documents": len(docs), "chunks": upserted}
