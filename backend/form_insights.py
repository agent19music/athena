"""Aggregate answers for a chat query that is actually about a form question.

retrieval.answer_query's default path finds the single nearest `documents`
chunk. For Tally that chunk is one respondent's whole submission, so "what's
the most common X" or "what's the sentiment on Y" was answered from whichever
one respondent happened to be the closest cosine match to the question, never
the population — even though form_answers/form_themes already hold the real
counts and clustered themes (see their module docstrings).

This module is the missing link: match the query to the form question it's
about (by embedding similarity against `form_questions.embedding`), then build
a plain-text breakdown from SQL aggregates (choice/numeric) or form_themes
(free text) for the LLM to phrase an answer from — grounded in real numbers,
not the wording of one respondent.

Additive: if nothing matches, retrieval falls through to today's document
search unchanged.
"""
import os

from sqlalchemy import text

from database import session_for_org

# Matching a query to a question label is a different task than matching a
# query to a document chunk (SIMILARITY_THRESHOLD), so it gets its own bar.
# Question labels are short and specific ("Which Linux distribution do you
# run?"), so a query that is genuinely about one scores high; kept stricter
# than the document threshold to avoid misrouting an unrelated question into
# an aggregate answer.
FORM_MATCH_THRESHOLD = float(os.getenv("FORM_MATCH_THRESHOLD", "0.72"))

# Rows shown per breakdown — enough to name the shape of the data without
# blowing up the synthesis prompt on a form with a long tail of options.
TOP_CHOICES = 12
TOP_THEMES = 3
THEME_SAMPLES_PER_THEME = 1
RAW_ANSWER_CAP = 40


async def match_form_question(query_embedding: list[float], org_id: str) -> dict | None:
    """Best-matching form question for this query, or None if nothing clears
    FORM_MATCH_THRESHOLD (including orgs with no Tally forms at all)."""
    if not org_id:
        raise ValueError("match_form_question requires an org_id")

    embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"
    sql = text("""
        SELECT
            fq.form_id, fq.question_id, fq.label, fq.kind, fd.name AS form_name,
            1 - (fq.embedding <=> cast(:embedding AS vector)) AS score
        FROM form_questions fq
        JOIN form_definitions fd ON fd.org_id = fq.org_id AND fd.form_id = fq.form_id
        WHERE fq.org_id = :org_id AND fq.embedding IS NOT NULL
        ORDER BY fq.embedding <=> cast(:embedding AS vector)
        LIMIT 1
    """)

    with session_for_org(org_id) as session:
        row = session.execute(sql, {"embedding": embedding_str, "org_id": org_id}).mappings().first()

    if not row or row["score"] < FORM_MATCH_THRESHOLD:
        return None
    return dict(row)


def _breakdown_choice(org_id: str, form_id: str, question_id: str) -> str | None:
    with session_for_org(org_id) as session:
        rows = session.execute(
            text("""
                SELECT choice, count(*) AS n
                FROM form_answers, unnest(answer_choices) AS choice
                WHERE org_id = :org_id AND form_id = :form_id AND question_id = :question_id
                GROUP BY choice
                ORDER BY n DESC
                LIMIT :limit
            """),
            {"org_id": org_id, "form_id": form_id, "question_id": question_id, "limit": TOP_CHOICES},
        ).all()
        total = session.execute(
            text("""
                SELECT count(*) FROM form_answers
                WHERE org_id = :org_id AND form_id = :form_id AND question_id = :question_id
                  AND answer_choices IS NOT NULL
            """),
            {"org_id": org_id, "form_id": form_id, "question_id": question_id},
        ).scalar() or 0

    if not rows:
        return None
    lines = [f"- {choice}: {n} response{'s' if n != 1 else ''}" for choice, n in rows]
    return f"{total} total responses.\n" + "\n".join(lines)


def _breakdown_numeric(org_id: str, form_id: str, question_id: str) -> str | None:
    with session_for_org(org_id) as session:
        row = session.execute(
            text("""
                SELECT count(*) AS n, avg(answer_numeric) AS avg, min(answer_numeric) AS lo, max(answer_numeric) AS hi
                FROM form_answers
                WHERE org_id = :org_id AND form_id = :form_id AND question_id = :question_id
                  AND answer_numeric IS NOT NULL
            """),
            {"org_id": org_id, "form_id": form_id, "question_id": question_id},
        ).mappings().first()

    if not row or not row["n"]:
        return None
    return (
        f"{row['n']} responses. Average {float(row['avg']):.1f}, "
        f"ranging from {row['lo']} to {row['hi']}."
    )


def _sentiment_header(org_id: str, form_id: str, question_id: str) -> tuple[str, int]:
    """Counts from the answer rows, so unclustered replies still show up."""
    with session_for_org(org_id) as session:
        row = session.execute(
            text("""
                SELECT count(*) AS n,
                       count(*) FILTER (WHERE sentiment = 'positive') AS pos,
                       count(*) FILTER (WHERE sentiment = 'negative') AS neg,
                       count(*) FILTER (WHERE sentiment = 'neutral') AS neu
                FROM form_answers
                WHERE org_id = :org_id AND form_id = :form_id AND question_id = :question_id
                  AND answer_text IS NOT NULL AND answer_text <> ''
            """),
            {"org_id": org_id, "form_id": form_id, "question_id": question_id},
        ).mappings().first()
    n = int(row["n"] or 0) if row else 0
    if not n:
        return "", 0
    pos, neg, neu = int(row["pos"] or 0), int(row["neg"] or 0), int(row["neu"] or 0)
    labelled = pos + neg + neu
    line = f"{n} free-text responses."
    if labelled:
        line += f" Sentiment: {pos} positive, {neg} negative, {neu} neutral."
        if labelled < n:
            line += f" {n - labelled} unlabelled."
    return line, n


def _breakdown_raw_answers(org_id: str, form_id: str, question_id: str, total: int) -> str:
    with session_for_org(org_id) as session:
        rows = session.execute(
            text("""
                SELECT answer_text, sentiment
                FROM form_answers
                WHERE org_id = :org_id AND form_id = :form_id AND question_id = :question_id
                  AND answer_text IS NOT NULL AND answer_text <> ''
                ORDER BY created_at, id
                LIMIT :limit
            """),
            {
                "org_id": org_id,
                "form_id": form_id,
                "question_id": question_id,
                "limit": RAW_ANSWER_CAP,
            },
        ).mappings().all()
    lines = []
    for row in rows:
        tone = row["sentiment"] or "unlabelled"
        text_value = " ".join((row["answer_text"] or "").split())
        if len(text_value) > 280:
            text_value = text_value[:277].rsplit(" ", 1)[0] + "…"
        lines.append(f"- ({tone}) \"{text_value}\"")
    note = ""
    if total > len(rows):
        note = f"\nShowing {len(rows)} of {total} answers."
    return "Individual answers, not yet grouped:\n" + "\n".join(lines) + note


def _breakdown_themes(org_id: str, form_id: str, question_id: str) -> str | None:
    header, total = _sentiment_header(org_id, form_id, question_id)
    if not total:
        return None

    with session_for_org(org_id) as session:
        themes = session.execute(
            text("""
                SELECT id, label, summary, size,
                       sentiment_positive, sentiment_negative, sentiment_neutral
                FROM form_themes
                WHERE org_id = :org_id AND form_id = :form_id AND question_id = :question_id
                ORDER BY size DESC
                LIMIT :limit
            """),
            {"org_id": org_id, "form_id": form_id, "question_id": question_id, "limit": TOP_THEMES},
        ).mappings().all()

    if not themes:
        return header + "\n" + _breakdown_raw_answers(org_id, form_id, question_id, total)

    lines = []
    with session_for_org(org_id) as session:
        for t in themes:
            samples = session.execute(
                text("""
                    SELECT a.answer_text
                    FROM form_answer_themes t
                    JOIN form_answers a ON a.id = t.answer_id
                    WHERE t.org_id = :org_id AND t.theme_id = :theme_id
                    ORDER BY t.distance ASC
                    LIMIT :n
                """),
                {"org_id": org_id, "theme_id": t["id"], "n": THEME_SAMPLES_PER_THEME},
            ).scalars().all()
            sentiment = (
                f"{t['sentiment_positive']} positive / "
                f"{t['sentiment_negative']} negative / "
                f"{t['sentiment_neutral']} neutral"
            )
            quotes = "; ".join(f'"{s}"' for s in samples if s)
            summary = f" {t['summary']}" if t["summary"] else ""
            lines.append(f"- {t['label']} ({t['size']} responses, {sentiment}).{summary} e.g. {quotes}")

    return header + "\nTop issues:\n" + "\n".join(lines)


def build_breakdown(org_id: str, question: dict) -> str | None:
    """Plain-text aggregate for `question`, or None if there's nothing to
    aggregate yet (caller should fall back to document search)."""
    kind = question["kind"]
    form_id, question_id = question["form_id"], question["question_id"]

    if kind in ("choice", "matrix"):
        return _breakdown_choice(org_id, form_id, question_id)
    if kind in ("number", "rating"):
        return _breakdown_numeric(org_id, form_id, question_id)
    if kind in ("short_text", "long_text"):
        return _breakdown_themes(org_id, form_id, question_id)
    return None
