import os
from contextlib import asynccontextmanager
from types import SimpleNamespace

from dotenv import load_dotenv

# Must run before any project-local import below, since several of them
# read env vars (e.g. SIMILARITY_THRESHOLD, DATABASE_URL) at module import
# time. Running the backend directly via `uvicorn main:app` (as documented
# in backend/CLAUDE.md) never otherwise loads backend/.env.
load_dotenv()

import sentry_sdk
from discord_alerts import before_send as sentry_before_send

_sentry_dsn = os.getenv("SENTRY_DSN")
if _sentry_dsn:
    sentry_sdk.init(
        dsn=_sentry_dsn,
        send_default_pii=True,
        traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "1.0")),
        profile_session_sample_rate=float(
            os.getenv("SENTRY_PROFILE_SESSION_SAMPLE_RATE", "1.0")
        ),
        profile_lifecycle="trace",
        environment=os.getenv("SENTRY_ENVIRONMENT", "development"),
        before_send=sentry_before_send,
    )

from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import func, text

from auth import AuthContext, require_auth, require_backend_secret, require_read_auth
import storage
from extract import SUPPORTED, extract_pdf, extract_text
from database import Conversation, DocumentChunk, Message, ensure_organization_exists, session_for_org
from embeddings import embed_documents
from ingest import create_ingest_job, run_ingestion
from retrieval import answer_query
from suggested_questions import questions_for_org


@asynccontextmanager
async def lifespan(app: FastAPI):
    from database import init_db
    init_db()
    yield


app = FastAPI(title="Athena API", lifespan=lifespan)

_cors_origins = os.getenv("CORS_ORIGINS", "*")
_allow_origins = [o.strip() for o in _cors_origins.split(",")] if _cors_origins != "*" else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    query: str
    org_id: str | None = None
    conversation_id: str | None = None   # None → start a new thread


class ChatResponse(BaseModel):
    answer: str
    type: str                       # "document" | "staff_fallback"
    conversation_id: str            # thread this turn belongs to
    source_title: str | None = None
    source_doc_id: str | None = None
    source_type: str | None = None  # "google_docs" | "notion" | "tally" | "upload" | "mock"
    source_excerpt: str | None = None  # raw chunk text, for preview-panel highlighting
    staff_name: str | None = None
    staff_email: str | None = None
    staff_domain: str | None = None
    staff_title: str | None = None
    staff_department: str | None = None
    similarity_score: float | None = None
    degraded: bool = False  # True when Gemini was unavailable/rate-limited and the raw chunk was returned unsynthesized


# Assistant source/staff metadata persisted per message — everything the answer
# dict carries except the answer text itself, so a reopened thread rebuilds cards.
_META_KEYS = (
    "type", "source_title", "source_doc_id", "source_type", "source_excerpt",
    "staff_name", "staff_email", "staff_domain", "staff_title",
    "staff_department", "similarity_score", "degraded",
)


def _title_from(query: str, limit: int = 60) -> str:
    q = " ".join(query.strip().split())
    return q[: limit - 1] + "…" if len(q) > limit else q or "New conversation"


@app.get("/health")
def health():
    return {"status": "ok"}


if os.getenv("SENTRY_DEBUG_ROUTE", "").lower() in ("1", "true", "yes"):
    @app.get("/sentry-debug")
    async def trigger_error():
        return 1 / 0


@app.get("/stats")
async def stats(auth_ctx: AuthContext = Depends(require_read_auth)):
    from billing import usage_snapshot
    from database import get_session

    org_id = auth_ctx.clerk_org_id
    with session_for_org(org_id) as db:
        last_chunk = (
            db.query(DocumentChunk)
            .filter(DocumentChunk.org_id == org_id)
            .order_by(DocumentChunk.created_at.desc())
            .first()
        )
        source_rows = (
            db.query(DocumentChunk.source_type)
            .filter(DocumentChunk.org_id == org_id)
            .distinct()
            .all()
        )
        last_synced = last_chunk.created_at.isoformat() if last_chunk else None
        indexed_types = [r[0] for r in source_rows if r[0]]

    # Entitlement + usage live outside RLS (org_subscriptions is not tenant-doc
    # data). Member count comes from organization_members when available.
    with get_session() as db:
        usage = usage_snapshot(db, org_id)

    return {
        "chunk_count": usage["chunks"],
        "last_synced": last_synced,
        "source_types": indexed_types,
        **usage,
    }


@app.get("/suggested-questions")
async def suggested_questions(auth_ctx: AuthContext = Depends(require_read_auth)):
    """Starter prompts for the empty chat, grounded on this org's chunks.

    Empty list when there is nothing indexed or Gemini/retrieval cannot
    produce questions that would actually match — the UI must not fall back
    to generic HR copy.
    """
    org_id = auth_ctx.clerk_org_id
    questions = await questions_for_org(org_id)
    return {"questions": questions}


# A Tally form with more responses than this collapses into one expandable
# group on the files page instead of one row per response. A busy form can hold
# thousands of submissions, which is unreadable as a flat list and pointless to
# serialize in full.
GROUP_THRESHOLD = 5
GROUP_PAGE_SIZE = 50
MAX_GROUP_PAGE_SIZE = 200

# Tally doc_ids are namespaced "tally:{org_id}:{form_id}_{submission_id}"
# (namespaced_doc_id + _tally_submission_to_doc), so the owning form is
# recoverable without a schema change — the third colon-segment up to the first
# underscore. Tally form ids are alphanumeric, so the underscore is unambiguous.
# tally/03 replaces this with a real form_id column; until then this works on
# already-indexed data with no re-ingest.
_TALLY_FORM_ID_SQL = "split_part(split_part(doc_id, ':', 3), '_', 1)"

# One document per doc_id. Used as a CTE by both the list and the group-children
# query so "a document" means the same thing in each.
_DOCS_CTE = """
    SELECT
        doc_id,
        max(title)         AS title,
        source_type,
        count(*)           AS chunks,
        max(created_at)    AS last_indexed
    FROM documents
    WHERE org_id = :org_id
    GROUP BY doc_id, source_type
"""


def _doc_row(r) -> dict:
    return {
        "kind": "document",
        "doc_id": r.doc_id,
        "title": r.title,
        "source_type": r.source_type,
        "chunks": r.chunks,
        "last_indexed": r.last_indexed.isoformat() if r.last_indexed else None,
    }


def _form_label(sample_title: str | None, form_id: str) -> str:
    """Tally doc titles are "{form_name} — response {id}", so the form name is
    the part before the separator. Falls back to the form id."""
    if sample_title and " — response " in sample_title:
        return sample_title.split(" — response ")[0]
    return sample_title or f"Form {form_id}"


@app.get("/documents")
async def list_documents(auth_ctx: AuthContext = Depends(require_read_auth)):
    """Files-page listing: individual documents, with large Tally forms collapsed
    into group entries.

    Returns a single `entries` list so the table renders one ordered sequence.
    Grouping is decided server-side: a form over GROUP_THRESHOLD responses emits
    one group entry (its children are fetched on expand via /documents/group),
    while a small form still emits a row per response.
    """
    org_id = auth_ctx.clerk_org_id

    groups_sql = text(f"""
        WITH docs AS ({_DOCS_CTE})
        SELECT
            {_TALLY_FORM_ID_SQL} AS form_id,
            count(*)             AS doc_count,
            sum(chunks)          AS chunks,
            max(last_indexed)    AS last_indexed,
            min(title)           AS sample_title
        FROM docs
        WHERE source_type = 'tally'
        GROUP BY {_TALLY_FORM_ID_SQL}
    """)

    # Everything that is not a Tally response, plus the responses of small forms.
    loose_sql = text(f"""
        WITH docs AS ({_DOCS_CTE})
        SELECT doc_id, title, source_type, chunks, last_indexed
        FROM docs
        WHERE source_type <> 'tally'
           OR {_TALLY_FORM_ID_SQL} = ANY(:small_forms)
        ORDER BY last_indexed DESC
    """)

    with session_for_org(org_id) as db:
        group_rows = db.execute(groups_sql, {"org_id": org_id}).mappings().all()

        small_forms = [r["form_id"] for r in group_rows if r["doc_count"] <= GROUP_THRESHOLD]
        loose_rows = db.execute(
            loose_sql, {"org_id": org_id, "small_forms": small_forms}
        ).mappings().all()

    entries = [_doc_row(SimpleNamespace(**r)) for r in loose_rows]

    for r in group_rows:
        if r["doc_count"] <= GROUP_THRESHOLD:
            continue  # already listed individually above
        entries.append({
            "kind": "group",
            "group_key": r["form_id"],
            "label": _form_label(r["sample_title"], r["form_id"]),
            "source_type": "tally",
            "doc_count": r["doc_count"],
            "chunks": int(r["chunks"] or 0),
            "last_indexed": r["last_indexed"].isoformat() if r["last_indexed"] else None,
        })

    # Newest first, with undated entries last rather than crashing the sort.
    entries.sort(key=lambda e: e["last_indexed"] or "", reverse=True)

    return {"entries": entries, "group_threshold": GROUP_THRESHOLD}


@app.get("/documents/group")
async def list_group_documents(
    key: str,
    limit: int = GROUP_PAGE_SIZE,
    offset: int = 0,
    auth_ctx: AuthContext = Depends(require_read_auth),
):
    """One page of the responses inside a Tally form group.

    Paginated because a single form can hold thousands of submissions; the files
    page fetches this only when a group is expanded.
    """
    org_id = auth_ctx.clerk_org_id
    limit = max(1, min(limit, MAX_GROUP_PAGE_SIZE))
    offset = max(0, offset)

    page_sql = text(f"""
        WITH docs AS ({_DOCS_CTE})
        SELECT doc_id, title, source_type, chunks, last_indexed
        FROM docs
        WHERE source_type = 'tally' AND {_TALLY_FORM_ID_SQL} = :key
        ORDER BY last_indexed DESC, doc_id
        LIMIT :limit OFFSET :offset
    """)
    count_sql = text(f"""
        WITH docs AS ({_DOCS_CTE})
        SELECT count(*) AS total
        FROM docs
        WHERE source_type = 'tally' AND {_TALLY_FORM_ID_SQL} = :key
    """)

    with session_for_org(org_id) as db:
        rows = db.execute(
            page_sql, {"org_id": org_id, "key": key, "limit": limit, "offset": offset}
        ).mappings().all()
        total = db.execute(count_sql, {"org_id": org_id, "key": key}).scalar() or 0

    return {
        "documents": [_doc_row(SimpleNamespace(**r)) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@app.get("/documents/preview")
async def preview_document(
    doc_id: str,
    source_type: str = "upload",
    auth_ctx: AuthContext = Depends(require_read_auth),
):
    """
    doc_id is the raw provider id (e.g. the uploaded filename) exactly as
    returned in ChatResponse.source_doc_id. Query param rather than a path
    segment, so we don't have to worry about escaping slashes from
    folder-upload relative-path filenames.

    Native pdf/docx modes require both a stored original (storage_path —
    only present for uploads made after the GCS storage layer shipped) and
    GCS actually being configured in this environment; everything else, and
    any upload made before that, falls back to reassembled text (or
    markdown mode, for .md).
    """
    from database import DocumentFile
    from ingest import namespaced_doc_id

    org_id = auth_ctx.clerk_org_id
    full_doc_id = namespaced_doc_id(source_type, org_id, doc_id)

    with session_for_org(org_id) as db:
        file_row = (
            db.query(DocumentFile)
            .filter(DocumentFile.org_id == org_id, DocumentFile.doc_id == full_doc_id)
            .first()
        )

        if file_row and file_row.storage_path and storage.enabled():
            if file_row.mime_type == "application/pdf":
                return {
                    "mode": "pdf",
                    "title": file_row.title,
                    "signed_url": storage.signed_url(file_row.storage_path),
                    "page_count": file_row.page_count,
                }
            if file_row.mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
                return {
                    "mode": "docx",
                    "title": file_row.title,
                    "signed_url": storage.signed_url(file_row.storage_path),
                }

        rows = (
            db.query(DocumentChunk.chunk_text, DocumentChunk.metadata_, DocumentChunk.title)
            .filter(DocumentChunk.org_id == org_id, DocumentChunk.doc_id == full_doc_id)
            .all()
        )

    if not rows:
        raise HTTPException(status_code=404, detail="Document not found.")

    ordered = sorted(rows, key=lambda r: (r.metadata_ or {}).get("chunk_index", 0))
    content = "\n\n".join(r.chunk_text for r in ordered)

    # .md uploads: the reassembled chunk text IS the original markdown source
    # (extract_text decodes .md as plain text, unmodified) — render it as
    # such instead of a flat paragraph. No storage/GCS dependency, unlike PDF.
    if file_row and file_row.mime_type == "text/markdown":
        return {"mode": "markdown", "title": ordered[0].title, "content": content}

    return {
        "mode": "text",
        "title": ordered[0].title,
        "content": content,
    }


@app.post("/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    auth_ctx: AuthContext = Depends(require_auth),
):
    if not request.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty.")

    # org_id + user_id come from the verified JWT — never trust the request body.
    org_id = auth_ctx.clerk_org_id
    user_id = auth_ctx.clerk_user_id
    query = request.query.strip()

    # Safety net: if onboarding's /ingest call and the Clerk webhook both missed
    # this org (see database.ensure_organization_exists), this is a Conversation/
    # Message FK insert away from a 500 instead of a working chat.
    ensure_organization_exists(org_id)

    # ---- Read phase: resolve the thread + prior turns (for multi-turn) --------
    # Kept separate from the write phase so no DB session is held across the
    # network-bound answer_query() call below.
    history: list[dict] = []
    conversation_id = request.conversation_id
    if conversation_id:
        with session_for_org(org_id) as db:
            convo = db.query(Conversation).filter_by(id=conversation_id).first()
            # Ownership: RLS already scopes to the org; enforce per-user here.
            if not convo or convo.user_id != user_id:
                raise HTTPException(status_code=404, detail="Conversation not found.")
            prior = (
                db.query(Message)
                .filter_by(conversation_id=conversation_id)
                .order_by(Message.created_at.asc())
                .all()
            )
            history = [{"role": m.role, "content": m.content} for m in prior]

    # ---- Answer (network I/O, no DB session held) -----------------------------
    result = await answer_query(query, org_id=org_id, history=history)
    metadata = {k: result[k] for k in _META_KEYS if result.get(k) is not None}

    # ---- Write phase: create thread if new, persist both turns ----------------
    with session_for_org(org_id) as db:
        if conversation_id:
            convo = db.query(Conversation).filter_by(id=conversation_id).first()
            if not convo or convo.user_id != user_id:
                raise HTTPException(status_code=404, detail="Conversation not found.")
            convo.updated_at = func.now()
        else:
            convo = Conversation(
                org_id=org_id, user_id=user_id, title=_title_from(query),
            )
            db.add(convo)
            db.flush()  # assign convo.id
        conversation_id = str(convo.id)

        db.add(Message(
            conversation_id=convo.id, org_id=org_id, user_id=user_id,
            role="user", content=query,
        ))
        db.add(Message(
            conversation_id=convo.id, org_id=org_id, user_id=user_id,
            role="assistant", content=result["answer"], metadata_=metadata,
        ))
        db.commit()

    return ChatResponse(conversation_id=conversation_id, **result)


# ---------------------------------------------------------------------------
# Conversations (chat history) — owner-scoped
# ---------------------------------------------------------------------------

@app.get("/conversations")
async def list_conversations(auth_ctx: AuthContext = Depends(require_auth)):
    """The caller's own threads in this org, most-recent first."""
    org_id, user_id = auth_ctx.clerk_org_id, auth_ctx.clerk_user_id
    with session_for_org(org_id) as db:
        rows = (
            db.query(Conversation)
            .filter(Conversation.user_id == user_id)
            .order_by(Conversation.updated_at.desc())
            .limit(100)
            .all()
        )
        return [
            {"id": str(c.id), "title": c.title, "updated_at": c.updated_at.isoformat()}
            for c in rows
        ]


@app.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: str, auth_ctx: AuthContext = Depends(require_auth)
):
    """Full transcript of one thread — owner only."""
    org_id, user_id = auth_ctx.clerk_org_id, auth_ctx.clerk_user_id
    with session_for_org(org_id) as db:
        convo = db.query(Conversation).filter_by(id=conversation_id).first()
        if not convo or convo.user_id != user_id:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        msgs = (
            db.query(Message)
            .filter_by(conversation_id=conversation_id)
            .order_by(Message.created_at.asc())
            .all()
        )
        return {
            "id": str(convo.id),
            "title": convo.title,
            "messages": [
                {
                    "id": str(m.id),
                    "role": m.role,
                    "content": m.content,
                    "metadata": m.metadata_ or {},
                    "created_at": m.created_at.isoformat(),
                }
                for m in msgs
            ],
        }


@app.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: str, auth_ctx: AuthContext = Depends(require_auth)
):
    org_id, user_id = auth_ctx.clerk_org_id, auth_ctx.clerk_user_id
    with session_for_org(org_id) as db:
        convo = db.query(Conversation).filter_by(id=conversation_id).first()
        if not convo or convo.user_id != user_id:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        db.delete(convo)  # FK ON DELETE CASCADE removes its messages
        db.commit()


# ---------------------------------------------------------------------------
# Analytics — admin only, org-wide aggregates (no individual chat content)
# ---------------------------------------------------------------------------

@app.get("/analytics")
async def analytics(auth_ctx: AuthContext = Depends(require_auth)):
    if not auth_ctx.is_admin:
        raise HTTPException(status_code=403, detail="Admins only.")
    org_id = auth_ctx.clerk_org_id

    with session_for_org(org_id) as db:
        questions = db.query(Message).filter(
            Message.org_id == org_id, Message.role == "user"
        )
        total_questions = questions.count()

        # Questions per day, last 14 days.
        day = func.date_trunc("day", Message.created_at)
        volume_rows = (
            db.query(day.label("day"), func.count().label("n"))
            .filter(Message.org_id == org_id, Message.role == "user")
            .filter(Message.created_at >= func.now() - text("interval '14 days'"))
            .group_by(day)
            .order_by(day)
            .all()
        )
        volume = [{"day": r.day.date().isoformat(), "count": r.n} for r in volume_rows]

        # Unanswered = assistant turns that fell back to the staff directory.
        unanswered_count = (
            db.query(Message)
            .filter(
                Message.org_id == org_id,
                Message.role == "assistant",
                Message.metadata_["type"].astext == "staff_fallback",
            )
            .count()
        )

        # Top questions (de-identified) — grouped by normalised text.
        norm = func.lower(func.trim(Message.content))
        top_rows = (
            db.query(norm.label("q"), func.count().label("n"))
            .filter(Message.org_id == org_id, Message.role == "user")
            .group_by(norm)
            .order_by(func.count().desc())
            .limit(10)
            .all()
        )
        top_questions = [{"question": r.q, "count": r.n} for r in top_rows]

        active_threads = (
            db.query(Conversation).filter(Conversation.org_id == org_id).count()
        )

    return {
        "total_questions": total_questions,
        "unanswered_count": unanswered_count,
        "active_threads": active_threads,
        "volume": volume,
        "top_questions": top_questions,
    }


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------

class IngestRequest(BaseModel):
    org_id: str | None = None
    org_name: str | None = None
    org_logo_url: str | None = None
    notion_api_key: str | None = None
    notion_root_page_id: str | None = None
    public_doc_ids: list[str] | None = None
    drive_folder_id: str | None = None
    tally_api_key: str | None = None
    tally_form_ids: list[str] | None = None
    tally_oauth_refresh_token: str | None = None
    tally_oauth_expires_in: int | None = None
    tally_oauth_scope: str | None = None
    trigger: str = "manual"



class EnsureOrgRequest(BaseModel):
    org_id: str
    org_name: str | None = None
    org_logo_url: str | None = None


@app.post("/organizations/ensure")
async def ensure_organization(
    request: EnsureOrgRequest,
    _: None = Depends(require_backend_secret),
):
    """Create a minimal organizations row for a Clerk org if missing.

    Used by onboarding when no knowledge sources are connected yet — so we do
    not open an empty ingest_jobs row, but still satisfy FKs for later writes.
    """
    from database import Organization, get_session

    if not request.org_id:
        raise HTTPException(status_code=400, detail="org_id is required")
    ensure_organization_exists(request.org_id, request.org_name)
    if request.org_name or request.org_logo_url:
        with get_session() as session:
            org = session.query(Organization).filter_by(clerk_org_id=request.org_id).first()
            if org:
                if request.org_name:
                    org.name = request.org_name
                if request.org_logo_url:
                    org.logo_url = request.org_logo_url
                session.commit()
    return {"ok": True, "org_id": request.org_id}


@app.post("/ingest", status_code=202)
async def ingest(
    background_tasks: BackgroundTasks,
    request: IngestRequest | None = None,
    _: None = Depends(require_backend_secret),
):
    """
    Trigger the ingestion pipeline for a single organization.
    Always requires an org_id — ingestion writes tenant-scoped data.

    Runs in the background: the caller gets 202 immediately so onboarding never
    blocks on document loading + embedding (tens of seconds). run_ingestion opens
    an `ingest_jobs` row (status="running") first thing and flips it to
    completed/failed itself, so progress stays observable via GET /ingest/status.
    """
    from billing import require_plan_capacity, source_keys_after_ingest
    from database import Organization, get_session

    req = request or IngestRequest()
    if not req.org_id:
        raise HTTPException(status_code=400, detail="org_id is required for ingestion.")

    # Onboarding / first sync can arrive before the Clerk webhook wrote the org
    # row. ingest_jobs FK requires organizations.clerk_org_id — create it now.
    ensure_organization_exists(req.org_id, req.org_name)

    # Plan gates: Drive is Pro-only; Starter is capped at 2 connector types.
    # Checked before we create a job so a blocked connect doesn't leave a
    # failed/empty ingest_jobs row.
    with get_session() as db:
        org = db.query(Organization).filter_by(clerk_org_id=req.org_id).first()
        proposed = source_keys_after_ingest(
            org,
            notion_api_key=req.notion_api_key,
            notion_root_page_id=req.notion_root_page_id,
            public_doc_ids=req.public_doc_ids,
            drive_folder_id=req.drive_folder_id,
            tally_api_key=req.tally_api_key,
            tally_form_ids=req.tally_form_ids,
        )
        if req.drive_folder_id:
            require_plan_capacity(db, req.org_id, "drive")
        # Only enforce source-type caps when the request is *adding* connectors,
        # not on a plain re-index of already-configured sources.
        adding = any(
            [
                req.notion_api_key and req.notion_root_page_id,
                req.public_doc_ids,
                req.tally_api_key and req.tally_form_ids,
                req.drive_folder_id,
            ]
        )
        if adding:
            require_plan_capacity(
                db, req.org_id, "add_source", proposed_sources=proposed
            )

    # Create the job row synchronously so the response can carry its id. The
    # client polls that id to know when the sync actually finished — a 202 alone
    # says nothing about completion, which is why the UI used to need a manual
    # refresh before a newly configured connector showed as connected.
    job_id = create_ingest_job(req.org_id, req.trigger)

    background_tasks.add_task(
        run_ingestion,
        org_id=req.org_id,
        org_name=req.org_name,
        org_logo_url=req.org_logo_url,
        notion_api_key=req.notion_api_key,
        notion_root_page_id=req.notion_root_page_id,
        public_doc_ids=req.public_doc_ids,
        drive_folder_id=req.drive_folder_id,
        tally_api_key=req.tally_api_key,
        tally_form_ids=req.tally_form_ids,
        tally_oauth_refresh_token=req.tally_oauth_refresh_token,
        tally_oauth_expires_in=req.tally_oauth_expires_in,
        tally_oauth_scope=req.tally_oauth_scope,
        trigger=req.trigger,
        job_id=job_id,
    )
    return {"status": "started", "org_id": req.org_id, "job_id": job_id}


@app.get("/ingest/status")
async def ingest_status(auth_ctx: AuthContext = Depends(require_read_auth)):
    """
    Recent ingestion runs for the caller's org — powers the connections page
    status and the dashboard activity feed. Explicitly org-filtered.
    """
    from database import IngestJob, get_session

    from public_error import public_error

    org_id = auth_ctx.clerk_org_id
    with get_session() as db:
        jobs = (
            db.query(IngestJob)
            .filter(IngestJob.org_id == org_id)
            .order_by(IngestJob.started_at.desc())
            .limit(10)
            .all()
        )
        return {
            "jobs": [
                {
                    "id": str(j.id),
                    "status": j.status,
                    "trigger": j.trigger,
                    "documents": j.documents,
                    "chunks": j.chunks,
                    "error": public_error(j.error, "Sync failed. Try again.") if j.error else None,
                    "started_at": j.started_at.isoformat() if j.started_at else None,
                    "finished_at": j.finished_at.isoformat() if j.finished_at else None,
                }
                for j in jobs
            ]
        }


@app.get("/ingest/jobs/{job_id}")
async def ingest_job(job_id: str, auth_ctx: AuthContext = Depends(require_read_auth)):
    """A single ingestion run, for polling one sync to completion.

    Org-filtered as well as id-filtered so a job id from another tenant reads
    as absent rather than leaking its status.
    """
    from database import IngestJob, get_session

    with get_session() as db:
        job = (
            db.query(IngestJob)
            .filter(IngestJob.id == job_id, IngestJob.org_id == auth_ctx.clerk_org_id)
            .first()
        )
        if not job:
            raise HTTPException(status_code=404, detail="No such ingestion job.")
        from public_error import public_error
        return {
            "id": str(job.id),
            "status": job.status,
            "trigger": job.trigger,
            "documents": job.documents,
            "chunks": job.chunks,
            "error": public_error(job.error, "Sync failed. Try again.") if job.error else None,
            "started_at": job.started_at.isoformat() if job.started_at else None,
            "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        }


# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------

# Which chunk source_type each connector writes. Drive is absent on purpose:
# its loader also tags chunks "google_docs" (ingest.py::load_from_drive), so
# Drive's indexed volume is not separable from public Docs today. Until it gets
# its own source_type, Drive reports from stored config + job state only.
_CONNECTOR_SOURCE_TYPES = {
    "notion": "notion",
    "google_docs": "google_docs",
    "tally": "tally",
}


@app.get("/connections")
async def connections(auth_ctx: AuthContext = Depends(require_read_auth)):
    """Per-connector state for the connections page.

    Reports *configuration* alongside indexed volume, which the UI cannot infer
    from /stats alone: source_types only says "chunks of this kind exist", so a
    connector with saved credentials but no data yet was indistinguishable from
    one that was never set up. Returns booleans — never the stored credentials.
    """
    from database import IngestJob, Organization, get_session

    org_id = auth_ctx.clerk_org_id

    with get_session() as db:
        org = db.query(Organization).filter_by(clerk_org_id=org_id).first()

        configured = {
            "notion": bool(org and org.notion_api_key),
            "google_docs": bool(org and org.public_doc_ids),
            "tally": bool(org and org.tally_api_key),
            "drive": bool(org and org.drive_folder_id),
        }

        latest = (
            db.query(IngestJob)
            .filter(IngestJob.org_id == org_id)
            .order_by(IngestJob.started_at.desc())
            .first()
        )

    # Indexed volume per source, from the tenant-scoped (RLS) session.
    with session_for_org(org_id) as db:
        rows = (
            db.query(
                DocumentChunk.source_type,
                func.count(DocumentChunk.id).label("chunks"),
                func.max(DocumentChunk.created_at).label("last_synced"),
            )
            .filter(DocumentChunk.org_id == org_id)
            .group_by(DocumentChunk.source_type)
            .all()
        )
    by_source = {r.source_type: r for r in rows}

    syncing = bool(latest and latest.status == "running")
    failed = bool(latest and latest.status == "failed")

    connectors = {}
    for key, is_configured in configured.items():
        row = by_source.get(_CONNECTOR_SOURCE_TYPES.get(key, ""))
        chunk_count = row.chunks if row else 0

        if not is_configured:
            # No credentials stored — genuinely not set up, not "partial".
            status = "disconnected"
        elif syncing:
            status = "syncing"
        elif chunk_count > 0:
            status = "connected"
        elif failed:
            status = "error"
        elif key == "drive":
            # Can't confirm from chunk counts (see _CONNECTOR_SOURCE_TYPES).
            status = "connected"
        else:
            # Credentials saved but the run produced nothing — bad key, empty
            # form, or revoked access. This is the one honest use of "partial".
            status = "partial"

        entry = {
            "configured": is_configured,
            "status": status,
            "chunk_count": chunk_count,
            "last_synced": row.last_synced.isoformat() if row and row.last_synced else None,
        }
        if key == "tally":
            forms = (org.tally_form_ids if org else None) or []
            entry["has_forms"] = bool(isinstance(forms, list) and any(forms))
            entry["oauth"] = bool(org and getattr(org, "tally_oauth_refresh_token", None))
        if key == "notion":
            entry["has_root"] = bool(org and org.notion_root_page_id)
            entry["oauth"] = bool(org and getattr(org, "notion_oauth", False))
            if org and org.notion_workspace_name:
                entry["workspace_name"] = org.notion_workspace_name
        connectors[key] = entry

    return {
        "connectors": connectors,
        "last_job": {
            "id": str(latest.id),
            "status": latest.status,
            "error": latest.error,
            "chunks": latest.chunks,
        } if latest else None,
    }




# ---------------------------------------------------------------------------
# Tally OAuth (Connect without pasted API keys)
# ---------------------------------------------------------------------------

class TallyOAuthSaveRequest(BaseModel):
    access_token: str
    refresh_token: str | None = None
    expires_in: int | None = None
    scope: str | None = None
    form_ids: list[str] | None = None
    trigger_ingest: bool = True


@app.post("/connections/tally/oauth")
async def save_tally_oauth(
    body: TallyOAuthSaveRequest,
    background_tasks: BackgroundTasks,
    auth_ctx: AuthContext = Depends(require_auth),
):
    """Persist Tally OAuth tokens for the caller's org and optionally ingest."""
    from datetime import datetime, timedelta, timezone

    from database import Organization, get_session
    from ingest import create_ingest_job, run_ingestion

    if not auth_ctx.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    from billing import require_plan_capacity, source_keys_after_ingest

    access = (body.access_token or "").strip()
    if not access:
        raise HTTPException(status_code=400, detail="access_token required")

    form_ids = [f.strip() for f in (body.form_ids or []) if isinstance(f, str) and f.strip()]

    with get_session() as db:
        org = db.query(Organization).filter_by(clerk_org_id=auth_ctx.clerk_org_id).first()
        proposed = source_keys_after_ingest(
            org,
            tally_api_key=access,
            tally_form_ids=form_ids or (org.tally_form_ids if org else None),
        )
        require_plan_capacity(
            db, auth_ctx.clerk_org_id, "add_source", proposed_sources=proposed
        )
        if not org:
            org = Organization(
                clerk_org_id=auth_ctx.clerk_org_id,
                name="Unnamed Organisation",
            )
            db.add(org)
        org.tally_api_key = access
        if body.refresh_token:
            org.tally_oauth_refresh_token = body.refresh_token.strip()
        if body.scope:
            org.tally_oauth_scope = body.scope.strip()
        if body.expires_in and body.expires_in > 0:
            org.tally_oauth_expires_at = datetime.now(timezone.utc) + timedelta(
                seconds=int(body.expires_in)
            )
        if form_ids:
            org.tally_form_ids = form_ids
        db.commit()

    job_id = None
    if body.trigger_ingest and form_ids:
        job_id = create_ingest_job(auth_ctx.clerk_org_id, "tally_oauth")
        background_tasks.add_task(
            run_ingestion,
            org_id=auth_ctx.clerk_org_id,
            tally_api_key=access,
            tally_form_ids=form_ids,
            tally_oauth_refresh_token=body.refresh_token,
            tally_oauth_expires_in=body.expires_in,
            tally_oauth_scope=body.scope,
            trigger="tally_oauth",
            job_id=job_id,
        )

    return {
        "ok": True,
        "has_forms": bool(form_ids),
        "form_count": len(form_ids),
        "job_id": str(job_id) if job_id else None,
    }


@app.get("/connections/tally/forms")
async def list_tally_forms(auth_ctx: AuthContext = Depends(require_auth)):
    """List Tally forms for the org using the stored OAuth/PAT token."""
    from database import Organization, get_session
    import tally_oauth

    if not auth_ctx.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    with get_session() as db:
        org = db.query(Organization).filter_by(clerk_org_id=auth_ctx.clerk_org_id).first()
        if not org or not org.tally_api_key:
            raise HTTPException(status_code=400, detail="Tally is not connected")
        try:
            token = tally_oauth.ensure_fresh_tally_token(org)
            db.commit()
        except tally_oauth.TallyOAuthError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

    try:
        forms = tally_oauth.list_forms(token or org.tally_api_key)
    except tally_oauth.TallyOAuthError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    slim = []
    for f in forms:
        if not isinstance(f, dict):
            continue
        fid = f.get("id") or f.get("formId")
        if not fid:
            continue
        slim.append(
            {
                "id": fid,
                "name": f.get("name") or f.get("title") or fid,
                "status": f.get("status"),
            }
        )
    return {"forms": slim}




# ---------------------------------------------------------------------------
# Notion OAuth (Connect without pasted integration token)
# ---------------------------------------------------------------------------

class NotionOAuthSaveRequest(BaseModel):
    access_token: str
    workspace_id: str | None = None
    workspace_name: str | None = None
    root_page_id: str | None = None
    trigger_ingest: bool = True


@app.post("/connections/notion/oauth")
async def save_notion_oauth(
    body: NotionOAuthSaveRequest,
    background_tasks: BackgroundTasks,
    auth_ctx: AuthContext = Depends(require_auth),
):
    """Persist Notion OAuth token for the caller's org and optionally ingest."""
    from database import Organization, get_session
    from ingest import create_ingest_job, run_ingestion

    if not auth_ctx.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    from billing import require_plan_capacity, source_keys_after_ingest

    access = (body.access_token or "").strip()
    if not access:
        raise HTTPException(status_code=400, detail="access_token required")

    root = (body.root_page_id or "").strip() or None

    with get_session() as db:
        org = db.query(Organization).filter_by(clerk_org_id=auth_ctx.clerk_org_id).first()
        root_for_gate = root or (org.notion_root_page_id if org else None)
        proposed = source_keys_after_ingest(
            org,
            notion_api_key=access,
            notion_root_page_id=root_for_gate,
        )
        require_plan_capacity(
            db, auth_ctx.clerk_org_id, "add_source", proposed_sources=proposed
        )
        if not org:
            org = Organization(
                clerk_org_id=auth_ctx.clerk_org_id,
                name="Unnamed Organisation",
            )
            db.add(org)
        org.notion_api_key = access
        org.notion_oauth = True
        if body.workspace_id:
            org.notion_workspace_id = body.workspace_id.strip()
        if body.workspace_name:
            org.notion_workspace_name = body.workspace_name.strip()
        if root:
            org.notion_root_page_id = root
        db.commit()

    job_id = None
    if body.trigger_ingest and root:
        job_id = create_ingest_job(auth_ctx.clerk_org_id, "notion_oauth")
        background_tasks.add_task(
            run_ingestion,
            org_id=auth_ctx.clerk_org_id,
            notion_api_key=access,
            notion_root_page_id=root,
            trigger="notion_oauth",
            job_id=job_id,
        )

    return {
        "ok": True,
        "has_root": bool(root),
        "job_id": str(job_id) if job_id else None,
    }


@app.get("/connections/notion/pages")
async def list_notion_pages(auth_ctx: AuthContext = Depends(require_auth)):
    """List Notion pages visible to the org's stored OAuth/integration token."""
    from database import Organization, get_session
    import notion_oauth

    if not auth_ctx.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    with get_session() as db:
        org = db.query(Organization).filter_by(clerk_org_id=auth_ctx.clerk_org_id).first()
        if not org or not org.notion_api_key:
            raise HTTPException(status_code=400, detail="Notion is not connected")
        token = org.notion_api_key

    try:
        pages = notion_oauth.search_pages(token)
    except notion_oauth.NotionOAuthError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    return {"pages": pages}


@app.post("/connections/notion/root")
async def set_notion_root(
    body: dict,
    background_tasks: BackgroundTasks,
    auth_ctx: AuthContext = Depends(require_auth),
):
    """Set the Notion root page id after OAuth and optionally ingest."""
    from database import Organization, get_session
    from ingest import create_ingest_job, run_ingestion

    if not auth_ctx.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    root = (body.get("root_page_id") or "").strip()
    if not root:
        raise HTTPException(status_code=400, detail="root_page_id required")
    trigger_ingest = body.get("trigger_ingest", True)

    with get_session() as db:
        org = db.query(Organization).filter_by(clerk_org_id=auth_ctx.clerk_org_id).first()
        if not org or not org.notion_api_key:
            raise HTTPException(status_code=400, detail="Notion is not connected")
        org.notion_root_page_id = root
        token = org.notion_api_key
        db.commit()

    job_id = None
    if trigger_ingest:
        job_id = create_ingest_job(auth_ctx.clerk_org_id, "notion_root")
        background_tasks.add_task(
            run_ingestion,
            org_id=auth_ctx.clerk_org_id,
            notion_api_key=token,
            notion_root_page_id=root,
            trigger="notion_root",
            job_id=job_id,
        )

    return {"ok": True, "root_page_id": root, "job_id": str(job_id) if job_id else None}


# ---------------------------------------------------------------------------
# File upload
# ---------------------------------------------------------------------------

MAX_TOTAL_BYTES = 150 * 1024 * 1024  # 150 MB per request


@app.post("/upload")
async def upload_files(
    files: list[UploadFile] = File(...),
    auth_ctx: AuthContext = Depends(require_auth),
):
    """
    Accept one or more files, extract text, chunk, embed, and upsert.
    org_id comes from the verified Clerk JWT — never from the request body.
    """
    import mimetypes
    from pathlib import Path
    from billing import require_plan_capacity
    from database import get_session
    from ingest import chunk_document, namespaced_doc_id

    org_id = auth_ctx.clerk_org_id

    # Safety net: see ensure_organization_exists — without this, a missing
    # organizations row surfaces as a raw ForeignKeyViolation 500 on the
    # DocumentChunk/DocumentFile insert below instead of the upload just working.
    ensure_organization_exists(org_id)

    total_size = sum(f.size or 0 for f in files)
    if total_size > MAX_TOTAL_BYTES:
        raise HTTPException(400, "Total upload exceeds 150 MB")

    # Plan gate before we spend CPU on extraction/embedding. Counts new
    # filenames that aren't already indexed as uploads for this org.
    from database import DocumentFile
    from ingest import namespaced_doc_id as _ns

    candidate_names = []
    for file in files:
        ext = Path(file.filename or "").suffix.lower()
        if ext in SUPPORTED and file.filename:
            candidate_names.append(file.filename)

    with get_session() as db:
        new_file_count = 0
        for name in candidate_names:
            doc_id = _ns("upload", org_id, name)
            exists = (
                db.query(DocumentFile)
                .filter_by(org_id=org_id, doc_id=doc_id, source_type="upload")
                .first()
            )
            if not exists:
                new_file_count += 1
        if new_file_count:
            require_plan_capacity(db, org_id, "upload_files", extra_files=new_file_count)

    print(f"Upload request: {len(files)} file(s)")
    docs = []
    skipped = []

    for file in files:
        ext = Path(file.filename or "").suffix.lower()

        if ext not in SUPPORTED:
            skipped.append({"name": file.filename, "reason": "This file type isn't supported."})
            continue

        raw = await file.read()
        print(f"Upload file: {file.filename} ({len(raw)} bytes)")

        page_count = None
        try:
            if ext == ".pdf":
                text, page_count = extract_pdf(raw)
            else:
                text = extract_text(file.filename, raw)
        except ValueError as e:
            from public_error import public_error
            skipped.append({"name": file.filename, "reason": public_error(str(e))})
            continue
        except Exception as e:
            sentry_sdk.capture_exception(e)
            print(f"Upload extract failed: {file.filename} ({len(raw)} bytes): {type(e).__name__}: {e}")
            skipped.append({"name": file.filename, "reason": "Couldn't read this file. Try another copy."})
            continue

        if not text.strip():
            skipped.append({"name": file.filename, "reason": "This file has no readable text."})
            continue

        title = Path(file.filename).stem.replace("_", " ").replace("-", " ").title()

        # Browsers/mimetypes are unreliable for .md specifically (often
        # empty or application/octet-stream); pin known extensions explicitly
        # rather than trust it, since the preview endpoint's mode switch
        # depends on this value being stable.
        _PINNED_MIME = {
            ".md": "text/markdown",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }
        mime_type = _PINNED_MIME.get(ext) or file.content_type or mimetypes.guess_type(file.filename)[0]
        storage_path = None
        if storage.enabled():
            try:
                storage_path = storage.upload_original(org_id, file.filename, raw, mime_type)
            except Exception as e:
                # Storage failure shouldn't block ingestion — the text pipeline
                # already succeeded; this doc just falls back to the text-only
                # preview instead of native rendering (see storage-path==null
                # handling in the frontend PreviewPanel).
                print(f"GCS upload failed for {file.filename}: {e}")

        docs.append({
            "doc_id": namespaced_doc_id("upload", org_id, file.filename),
            "title": title,
            "content": text,
            "source_type": "upload",
            "storage_path": storage_path,
            "mime_type": mime_type,
            "byte_size": len(raw),
            "page_count": page_count,
        })

    if not docs:
        return {"status": "ok", "uploaded": 0, "chunks": 0, "skipped": skipped}

    from database import DocumentChunk, DocumentFile

    all_chunks = []
    for doc in docs:
        all_chunks.extend(chunk_document(doc))

    # Chunk quota — reject before embedding if post-upsert total would overflow.
    with get_session() as db:
        from billing import resolve_entitlement
        from sqlalchemy import func as sa_func

        doc_ids = [d["doc_id"] for d in docs]
        current = (
            db.query(sa_func.count(DocumentChunk.id))
            .filter(DocumentChunk.org_id == org_id)
            .scalar()
            or 0
        )
        old_for = (
            db.query(sa_func.count(DocumentChunk.id))
            .filter(DocumentChunk.org_id == org_id, DocumentChunk.doc_id.in_(doc_ids))
            .scalar()
            or 0
        )
        projected = current - old_for + len(all_chunks)
        ent = resolve_entitlement(db, org_id)
        if projected > ent.limits.chunks:
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "plan_limit",
                    "limit_name": "chunks",
                    "used": current,
                    "limit": ent.limits.chunks,
                    "plan": ent.plan,
                    "upgrade_path": "/admin/billing",
                    "message": (
                        f"Chunk limit reached on the {ent.limits.name} plan."
                        + (" Upgrade to continue." if ent.plan == "starter" else "")
                    ),
                },
            )

    try:
        embeddings = await embed_documents([c["chunk_text"] for c in all_chunks])
    except Exception as e:
        sentry_sdk.capture_exception(e)
        print(f"Upload embed failed ({len(all_chunks)} chunks): {type(e).__name__}: {e}")
        from public_error import public_error
        raise HTTPException(
            status_code=503,
            detail=public_error(str(e), "Couldn't index this file. Try again in a few minutes."),
        )

    seen_docs: set[str] = set()
    try:
        with session_for_org(org_id) as session:
            upserted = 0
            for chunk, embedding in zip(all_chunks, embeddings):
                # Clear a doc's old chunks once, on first sighting — deleting inside
                # the loop would autoflush and drop chunks just inserted for the doc.
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
                    source_type="upload",
                ))
                upserted += 1

            for doc in docs:
                session.query(DocumentFile).filter_by(doc_id=doc["doc_id"], org_id=org_id).delete()
                session.add(DocumentFile(
                    org_id=org_id,
                    doc_id=doc["doc_id"],
                    source_type="upload",
                    title=doc["title"],
                    storage_path=doc["storage_path"],
                    mime_type=doc["mime_type"],
                    byte_size=doc["byte_size"],
                    page_count=doc["page_count"],
                ))

            session.commit()
    except HTTPException:
        raise
    except Exception as e:
        sentry_sdk.capture_exception(e)
        print(f"Upload store failed: {type(e).__name__}: {e}")
        from public_error import public_error
        raise HTTPException(
            status_code=503,
            detail=public_error(str(e), "Couldn't save this file. Try again."),
        )

    print(f"Upload indexed: {len(docs)} file(s), {upserted} chunks")
    return {
        "status": "ok",
        "uploaded": len(docs),
        "chunks": upserted,
        "skipped": skipped,
    }


# ---------------------------------------------------------------------------
# Billing (Paddle + promo entitlements)
# ---------------------------------------------------------------------------

class RedeemRequest(BaseModel):
    code: str


@app.get("/billing/entitlement")
async def billing_entitlement(auth_ctx: AuthContext = Depends(require_read_auth)):
    from billing import usage_snapshot
    from database import get_session

    with get_session() as db:
        return usage_snapshot(db, auth_ctx.clerk_org_id)


class CheckoutRequest(BaseModel):
    plan: str = "pro"
    interval: str = "month"
    quantity: int | None = None


class LockCheckoutRequest(BaseModel):
    transaction_id: str


@app.post("/billing/checkout")
async def billing_checkout(
    body: CheckoutRequest | None = None,
    auth_ctx: AuthContext = Depends(require_auth),
):
    """Create a Paddle transaction for overlay checkout (org admin)."""
    import paddle as paddle_api
    from billing import PLANS, count_members, resolve_entitlement
    from database import get_session

    req = body or CheckoutRequest()
    plan = (req.plan or "pro").lower()
    if plan == "plus":
        plan = "advanced"
    if plan not in ("starter", "pro", "advanced"):
        raise HTTPException(status_code=400, detail="Plan must be starter, pro, or advanced.")
    interval = "year" if (req.interval or "month") == "year" else "month"

    if not auth_ctx.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    if not paddle_api.configured():
        raise HTTPException(
            status_code=503,
            detail="Billing is not configured. Set PADDLE_API_KEY and a price id.",
        )

    ensure_organization_exists(auth_ctx.clerk_org_id)

    with get_session() as db:
        ent = resolve_entitlement(db, auth_ctx.clerk_org_id)
        if (
            ent.is_paid
            and ent.source == "paddle"
            and ent.status in ("active", "trialing")
            and ent.plan == plan
        ):
            raise HTTPException(status_code=400, detail=f"Already subscribed to {ent.limits.name}.")
        db_seats = max(1, count_members(db, auth_ctx.clerk_org_id) or 1)
        customer_id = ent.paddle_customer_id

    clerk_seats = max(1, int(req.quantity)) if req.quantity else None
    # Clerk memberships are the source of truth (Team page). Local
    # organization_members lags when webhooks are missing.
    seats = clerk_seats if clerk_seats is not None else db_seats
    seats = min(max(1, seats), PLANS[plan].seats)

    try:
        txn = paddle_api.create_checkout_transaction(
            quantity=seats,
            clerk_org_id=auth_ctx.clerk_org_id,
            plan=plan,
            interval=interval,
            paddle_customer_id=customer_id,
        )
    except paddle_api.PaddleError as e:
        print(f"Paddle checkout error: {e} body={e.body}")
        raise HTTPException(status_code=502, detail="Could not start Paddle checkout.")

    return {
        "transaction_id": txn.get("id"),
        "quantity": seats,
        "plan": plan,
        "interval": interval,
        "client_token": os.getenv("PADDLE_CLIENT_TOKEN", "") or None,
        "environment": os.getenv("PADDLE_ENVIRONMENT", "sandbox"),
        "price_id": paddle_api.price_id_for_plan(plan, interval),
    }


@app.post("/billing/lock-checkout")
async def billing_lock_checkout(
    body: LockCheckoutRequest,
    auth_ctx: AuthContext = Depends(require_auth),
):
    """Lock overlay checkout quantity to the org's member count."""
    import paddle as paddle_api

    if not auth_ctx.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    if not paddle_api.configured():
        raise HTTPException(status_code=503, detail="Billing is not configured.")

    txn_id = (body.transaction_id or "").strip()
    if not txn_id.startswith("txn_"):
        raise HTTPException(status_code=400, detail="transaction_id required")

    try:
        txn = paddle_api.lock_checkout_transaction(
            txn_id, clerk_org_id=auth_ctx.clerk_org_id
        )
    except paddle_api.PaddleError as e:
        if e.status == 403:
            raise HTTPException(status_code=403, detail="Not your checkout.")
        if e.status == 404:
            raise HTTPException(status_code=404, detail="Checkout not found.")
        print(f"Paddle lock-checkout error: {e} body={e.body}")
        raise HTTPException(status_code=502, detail="Could not lock checkout quantity.")

    return {"transaction_id": txn.get("id"), "status": txn.get("status")}


@app.post("/billing/cancel")
async def billing_cancel(auth_ctx: AuthContext = Depends(require_auth)):
    import paddle as paddle_api
    from billing import resolve_entitlement
    from database import get_session

    if not auth_ctx.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    with get_session() as db:
        ent = resolve_entitlement(db, auth_ctx.clerk_org_id)
        sub_id = ent.paddle_subscription_id
        if not (ent.source == "paddle" and sub_id):
            raise HTTPException(status_code=400, detail="No active Paddle subscription to cancel.")

    try:
        sub = paddle_api.cancel_subscription(sub_id)
    except paddle_api.PaddleError as e:
        print(f"Paddle cancel error: {e} body={e.body}")
        raise HTTPException(status_code=502, detail="Could not cancel subscription.")

    from database import get_session as _gs
    with _gs() as db:
        paddle_api.apply_subscription_event(db, sub, clerk_org_id=auth_ctx.clerk_org_id)
        db.commit()

    return {"status": "ok", "subscription": {"id": sub.get("id"), "status": sub.get("status")}}


@app.post("/billing/redeem")
async def billing_redeem(body: RedeemRequest, auth_ctx: AuthContext = Depends(require_auth)):
    from billing import redeem_promo, usage_snapshot
    from database import get_session

    if not auth_ctx.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    ensure_organization_exists(auth_ctx.clerk_org_id)

    with get_session() as db:
        redeem_promo(
            db,
            clerk_org_id=auth_ctx.clerk_org_id,
            clerk_user_id=auth_ctx.clerk_user_id,
            code=body.code,
        )
        return usage_snapshot(db, auth_ctx.clerk_org_id)


@app.post("/billing/check-seat")
async def billing_check_seat(auth_ctx: AuthContext = Depends(require_auth)):
    """Invite flow: ensure adding one more seat is allowed on the current plan."""
    from billing import require_plan_capacity
    from database import get_session

    if not auth_ctx.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    with get_session() as db:
        require_plan_capacity(db, auth_ctx.clerk_org_id, "add_seats", extra_seats=1)
        return {"ok": True}


@app.post("/billing/webhooks/paddle")
async def paddle_webhook(request: Request):
    """Paddle Billing webhooks — signature verified on the raw body."""
    import paddle as paddle_api
    from database import get_session

    raw = await request.body()
    sig = request.headers.get("Paddle-Signature") or request.headers.get("paddle-signature")
    if not paddle_api.verify_webhook_signature(raw, sig):
        raise HTTPException(status_code=401, detail="Invalid Paddle signature")

    import json
    try:
        payload = json.loads(raw.decode() or "{}")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    event_type = payload.get("event_type") or payload.get("eventType") or ""
    data = payload.get("data") or {}
    print(f"Paddle webhook: {event_type}")

    with get_session() as db:
        if event_type.startswith("subscription."):
            org = paddle_api.apply_subscription_event(db, data)
            db.commit()
            return {"received": True, "org_id": org, "type": event_type}

        if event_type == "transaction.completed":
            # Subscription may already be created; custom_data carries org id.
            org_id = paddle_api.clerk_org_from_custom_data(data)
            sub_id = data.get("subscription_id")
            if sub_id and org_id:
                try:
                    sub = paddle_api.get_subscription(sub_id)
                    # Ensure custom_data is present for apply.
                    if not paddle_api.clerk_org_from_custom_data(sub):
                        sub = {**sub, "custom_data": {"clerk_org_id": org_id}}
                    paddle_api.apply_subscription_event(db, sub, clerk_org_id=org_id)
                    db.commit()
                except paddle_api.PaddleError as e:
                    print(f"Paddle webhook fetch sub failed: {e}")
            return {"received": True, "org_id": org_id, "type": event_type}

    return {"received": True, "type": event_type}


def _sync_paddle_seats(clerk_org_id: str) -> None:
    """Best-effort: push local member count to Paddle quantity for paid orgs."""
    import paddle as paddle_api
    from billing import count_members, resolve_entitlement
    from database import get_session

    if not paddle_api.configured():
        return
    with get_session() as db:
        ent = resolve_entitlement(db, clerk_org_id)
        if not (ent.is_paid and ent.source == "paddle" and ent.paddle_subscription_id):
            return
        if ent.status not in ("active", "trialing", "past_due"):
            return
        seats = max(1, count_members(db, clerk_org_id) or 1)
        if seats == ent.seats_billed:
            return
        sub_id = ent.paddle_subscription_id
        price_id = paddle_api.price_id_for_plan(ent.plan)
    try:
        sub = paddle_api.update_subscription_quantity(sub_id, seats, price_id=price_id)
        with get_session() as db:
            paddle_api.apply_subscription_event(db, sub, clerk_org_id=clerk_org_id)
            db.commit()
    except paddle_api.PaddleError as e:
        print(f"Paddle seat sync failed for {clerk_org_id}: {e} body={e.body}")


# ---------------------------------------------------------------------------
# Clerk webhooks — syncs org/member events to local DB
# ---------------------------------------------------------------------------

@app.post("/webhooks/clerk")
async def clerk_webhook(
    request: Request,
    _: None = Depends(require_backend_secret),
):
    """
    Applies a Clerk webhook event to the local DB (org + membership sync).

    Signature verification happens at the public edge — the Next.js route
    `app/api/webhooks/clerk` verifies the Svix signature with CLERK_WEBHOOK_SECRET
    and forwards the verified `{type, data}` here behind the shared backend secret.
    This endpoint therefore never trusts an unauthenticated caller.
    """
    from database import Organization, OrganizationMember, get_session

    payload = await request.json()
    event_type = payload.get("type", "")
    data = payload.get("data", {}) or {}
    print(f"Clerk webhook: {event_type}")

    def _role_from_clerk(role: str | None) -> str:
        return "admin" if role in ("org:admin", "admin") else "member"

    seat_sync_org: str | None = None

    with get_session() as db:
        if event_type in ("organization.created", "organization.updated"):
            clerk_org_id = data.get("id")
            if not clerk_org_id:
                return {"received": True, "skipped": "no org id"}
            org = db.query(Organization).filter_by(clerk_org_id=clerk_org_id).first()
            name = data.get("name") or (org.name if org else "Unnamed Organisation")
            logo = data.get("image_url") or data.get("logo_url")
            if org:
                org.name = name
                if logo:
                    org.logo_url = logo
            else:
                db.add(Organization(clerk_org_id=clerk_org_id, name=name, logo_url=logo))
            db.commit()

        elif event_type == "organization.deleted":
            clerk_org_id = data.get("id")
            if clerk_org_id:
                # FK ON DELETE CASCADE clears documents/document_files/ingest_jobs
                # rows; members key on the org string separately, so remove them
                # explicitly. GCS objects live outside Postgres entirely — the
                # cascade can't reach them, so delete the org's stored files here.
                storage.delete_org_prefix(clerk_org_id)
                db.query(OrganizationMember).filter_by(clerk_org_id=clerk_org_id).delete()
                db.query(Organization).filter_by(clerk_org_id=clerk_org_id).delete()
                db.commit()

        elif event_type in ("organizationMembership.created", "organizationMembership.updated"):
            org_data = data.get("organization", {}) or {}
            user_data = data.get("public_user_data", {}) or {}
            clerk_org_id = org_data.get("id")
            clerk_user_id = user_data.get("user_id")
            if not (clerk_org_id and clerk_user_id):
                return {"received": True, "skipped": "missing org/user id"}
            name = " ".join(
                p for p in (user_data.get("first_name"), user_data.get("last_name")) if p
            ).strip() or None
            member = (
                db.query(OrganizationMember)
                .filter_by(clerk_org_id=clerk_org_id, clerk_user_id=clerk_user_id)
                .first()
            )
            if member:
                member.role = _role_from_clerk(data.get("role"))
                if user_data.get("identifier"):
                    member.email = user_data["identifier"]
                if name:
                    member.name = name
            else:
                db.add(OrganizationMember(
                    clerk_user_id=clerk_user_id,
                    clerk_org_id=clerk_org_id,
                    email=user_data.get("identifier") or "",
                    name=name,
                    role=_role_from_clerk(data.get("role")),
                ))
            db.commit()
            seat_sync_org = clerk_org_id

        elif event_type == "organizationMembership.deleted":
            org_data = data.get("organization", {}) or {}
            user_data = data.get("public_user_data", {}) or {}
            clerk_org_id = org_data.get("id")
            clerk_user_id = user_data.get("user_id")
            if clerk_org_id and clerk_user_id:
                db.query(OrganizationMember).filter_by(
                    clerk_org_id=clerk_org_id, clerk_user_id=clerk_user_id
                ).delete()
                db.commit()
                seat_sync_org = clerk_org_id

    if seat_sync_org:
        _sync_paddle_seats(seat_sync_org)

    return {"received": True, "type": event_type}


# ---------------------------------------------------------------------------
# Waitlist
# ---------------------------------------------------------------------------

class WaitlistRequest(BaseModel):
    name: str
    email: str
    company: str
    role: str


@app.post("/waitlist")
async def join_waitlist(body: WaitlistRequest):
    import httpx
    from database import Waitlist, get_session
    from sqlalchemy.exc import IntegrityError

    if "@" not in body.email or "." not in body.email:
        raise HTTPException(status_code=400, detail="Invalid email format")

    email = body.email.lower().strip()

    with get_session() as session:
        try:
            waitlist_entry = Waitlist(
                name=body.name.strip(),
                email=email,
                company=body.company.strip(),
                role=body.role.strip()
            )
            session.add(waitlist_entry)
            session.commit()
        except IntegrityError:
            session.rollback()
            return {"status": "duplicate", "message": "You're already on the waitlist!"}

    AUTOSEND_API_KEY = os.getenv("AUTOSEND_API_KEY", "")
    AUTOSEND_TEMPLATE_ID = os.getenv("AUTOSEND_TEMPLATE_ID", "")
    AUTOSEND_FROM_EMAIL = os.getenv("AUTOSEND_FROM_EMAIL", "")
    AUTOSEND_FROM_NAME = os.getenv("AUTOSEND_FROM_NAME", "Athena")

    if AUTOSEND_API_KEY and AUTOSEND_TEMPLATE_ID and AUTOSEND_FROM_EMAIL:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.autosend.com/v1/mails/send",
                headers={
                    "Authorization": f"Bearer {AUTOSEND_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "to": {"email": email, "name": body.name.strip()},
                    "from": {"email": AUTOSEND_FROM_EMAIL, "name": AUTOSEND_FROM_NAME},
                    "templateId": AUTOSEND_TEMPLATE_ID,
                    "dynamicData": {
                        "name": body.name.strip(),
                        "company": body.company.strip(),
                        "role": body.role.strip()
                    }
                },
            )

        if resp.status_code >= 400:
            print(f"Autosend error {resp.status_code}: {resp.text}")
    else:
        print("Autosend skipped: missing AUTOSEND_API_KEY, AUTOSEND_TEMPLATE_ID, or AUTOSEND_FROM_EMAIL")

    return {"status": "success", "message": "You're on the waitlist!"}


# ---------------------------------------------------------------------------
# Integration interest ("Notify me" on not-yet-shipped connectors)
# ---------------------------------------------------------------------------

_NOTIFIABLE_INTEGRATIONS = {"slack", "confluence"}


class IntegrationNotifyRequest(BaseModel):
    integration: str
    email: str | None = None


@app.get("/integrations/notify")
async def list_integration_interest(auth_ctx: AuthContext = Depends(require_read_auth)):
    """Which not-yet-shipped integrations this org already registered interest
    in — lets the connections page render "Noted" after a reload instead of
    resetting every "Notify me" button to its initial state."""
    from database import IntegrationInterest, get_session

    with get_session() as db:
        rows = (
            db.query(IntegrationInterest)
            .filter(IntegrationInterest.org_id == auth_ctx.clerk_org_id)
            .all()
        )
        return {"integrations": [r.integration for r in rows]}


@app.post("/integrations/notify", status_code=201)
async def register_integration_interest(
    body: IntegrationNotifyRequest,
    auth_ctx: AuthContext = Depends(require_auth),
):
    """Records that this org wants to hear when `integration` ships. This *is*
    the mailing list — querying it by integration is how we'll know who to
    email once Slack/Confluence go live. No outbound email here yet; there is
    no changelog-ready template to send, unlike the waitlist's Autosend flow."""
    from database import IntegrationInterest, get_session
    from sqlalchemy.exc import IntegrityError

    integration = body.integration.strip().lower()
    if integration not in _NOTIFIABLE_INTEGRATIONS:
        raise HTTPException(status_code=400, detail=f"Unknown integration '{body.integration}'")

    # Safety net: see ensure_organization_exists — otherwise a missing org row's
    # FK violation gets misreported as "already registered" by the except below.
    ensure_organization_exists(auth_ctx.clerk_org_id)

    with get_session() as db:
        try:
            db.add(IntegrationInterest(
                org_id=auth_ctx.clerk_org_id,
                integration=integration,
                requested_by=auth_ctx.clerk_user_id,
                email=body.email.strip() if body.email else None,
            ))
            db.commit()
        except IntegrityError:
            db.rollback()  # already registered for this org — idempotent no-op

    return {"status": "ok", "integration": integration}
