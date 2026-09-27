import os

from sqlalchemy import text

from database import session_for_org
from embeddings import embed_query
from form_insights import build_breakdown, build_form_overview, match_form_question, query_wants_overview
from generation import condense_question, synthesize_answer, synthesize_form_answer

SIMILARITY_THRESHOLD = float(os.getenv("SIMILARITY_THRESHOLD", "0.65"))


def _provider_doc_id(doc_id: str) -> str:
    """Reverse namespaced_doc_id ("{source}:{org}:{provider_id}") back to the raw
    provider id, so the UI source link (docs.google.com/document/d/<id>) resolves.
    Provider ids never contain ':', so the part after the second colon is safe."""
    return doc_id.split(":", 2)[-1]


async def similarity_search(
    query_embedding: list[float],
    org_id: str,
    top_k: int = 5,
) -> list[dict]:
    # org_id is mandatory: an unscoped vector search would read across every
    # tenant. There is no fallback branch by design.
    if not org_id:
        raise ValueError("similarity_search requires an org_id")

    embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"

    # The explicit WHERE is belt-and-suspenders; RLS on the org-scoped session
    # already restricts rows to this tenant even without it.
    sql = text("""
        SELECT
            id, doc_id, title, chunk_text, metadata, source_type,
            1 - (embedding <=> cast(:embedding AS vector)) AS similarity_score
        FROM documents
        WHERE org_id = :org_id
        ORDER BY embedding <=> cast(:embedding AS vector)
        LIMIT :top_k
    """)
    params = {"embedding": embedding_str, "top_k": top_k, "org_id": org_id}

    with session_for_org(org_id) as session:
        rows = session.execute(sql, params).mappings().all()

    return [dict(row) for row in rows]


async def answer_query(
    query: str, org_id: str, history: list[dict] | None = None
) -> dict:
    if not org_id:
        raise ValueError("answer_query requires an org_id")
    # Multi-turn: rewrite a context-dependent follow-up into a standalone query
    # so retrieval finds the right chunk ("how much notice?" → "...for leave?").
    search_query = await condense_question(query, history)
    query_embedding = await embed_query(search_query)

    # "Give me an overview" is about the survey, not whichever submission
    # happens to embed nearest to those words. A Tally chunk is one person's
    # entire form, so falling through to it dumps a raw response.
    if query_wants_overview(search_query):
        overview = build_form_overview(org_id)
        if overview:
            answer, degraded = await synthesize_form_answer(
                query, "survey overview", overview["breakdown"], history
            )
            return {
                "answer": answer,
                "type": "document",
                "source_title": f"{overview['form_name']} · overview",
                "source_doc_id": None,
                "source_type": "tally",
                "source_excerpt": overview["breakdown"][:500],
                "similarity_score": None,
                "degraded": degraded,
            }
        return {
            "answer": (
                "I don't have grouped survey responses yet, so I can't give an overview. "
                "Sync the form, then ask again."
            ),
            "type": "staff_fallback",
            "similarity_score": None,
        }

    # A query about a form question ("what's the most common X", "how do people
    # feel about Y") needs the population, not the one submission a plain
    # top-1 document match would happen to return. Check this first: it's a
    # stricter, more specific match than document search, so a hit here is
    # trusted over whatever document search would have found.
    form_question = await match_form_question(query_embedding, org_id)
    if form_question:
        breakdown = build_breakdown(org_id, form_question)
        if breakdown:
            answer, degraded = await synthesize_form_answer(query, form_question["label"], breakdown, history)
            return {
                "answer": answer,
                "type": "document",
                "source_title": f"{form_question['form_name']} · {form_question['label']}",
                "source_doc_id": None,
                "source_type": "tally",
                "source_excerpt": breakdown[:500],
                "similarity_score": round(form_question["score"], 4),
                "degraded": degraded,
            }

    results = await similarity_search(query_embedding, org_id=org_id)

    if results and results[0]["similarity_score"] >= SIMILARITY_THRESHOLD:
        best = results[0]
        # Synthesise a plain-language answer from the chunk instead of returning
        # the raw (often legalese) text. The source card still cites the chunk.
        answer, degraded = await synthesize_answer(query, best["chunk_text"], history)
        return {
            "answer": answer,
            "type": "document",
            "source_title": best["title"],
            "source_doc_id": _provider_doc_id(best["doc_id"]),
            "source_type": best.get("source_type", "mock"),
            # Raw chunk text (not the paraphrased answer above) — the preview
            # panel needs a literal substring of the source document to
            # highlight, which a synthesized answer can't guarantee.
            "source_excerpt": best["chunk_text"][:500],
            "similarity_score": round(best["similarity_score"], 4),
            "degraded": degraded,
        }

    # Low confidence — never hallucinate a document answer, and never invent a
    # contact either. There is no per-org staff directory yet, so the only
    # honest answer here is "no match" — see docs/planning/DEV-PATH.md.
    return {
        "answer": "I don't have documentation on this topic. Try rephrasing, or check with your team directly.",
        "type": "staff_fallback",
        "similarity_score": results[0]["similarity_score"] if results else None,
    }
