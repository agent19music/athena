"""
LLM answer synthesis.

Retrieval finds the best-matching document chunk; this turns that chunk into a
short, plain-language answer to the employee's question. The model is grounded
strictly on the chunk — no outside knowledge, no invention — so the answer stays
traceable to the cited source card the UI shows alongside it.

Falls back to returning the raw chunk if generation fails (bad model name,
quota, network) so chat never hard-fails on the synthesis step.
"""
import asyncio
import json
import os
from typing import Callable

import httpx
from google import genai
from google.genai import types

from gemini_retry import call_with_retry, is_retryable

GEN_MODEL = os.getenv("GEN_MODEL", "gemini-2.5-flash")
# Gemini quotas are per-model, so a different model often still has headroom
# when the primary hits its rate limit. Tried once, after retries on the
# primary are exhausted, before giving up and letting the caller degrade.
GEN_FALLBACK_MODEL = os.getenv("GEN_FALLBACK_MODEL", "gemini-2.5-flash-lite")
GEN_MAX_RETRIES = int(os.getenv("GEN_MAX_RETRIES", "3"))
GEN_MAX_BACKOFF = float(os.getenv("GEN_MAX_BACKOFF", "8"))

_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

# Tally retrospect only. Document chat and embeddings stay on Gemini.
# BREV_BASE_URL is the OpenAI-compatible root, including /v1.
BREV_BASE_URL = (os.getenv("BREV_BASE_URL") or "").rstrip("/")
BREV_API_KEY = os.getenv("BREV_API_KEY") or ""
BREV_MODEL = os.getenv("BREV_MODEL", "athena")


def _call_gemini(build_response: Callable[[str], str]) -> str:
    """Run build_response(model) against GEN_MODEL with retry/backoff on
    transient errors; if it's still rate-limited/unavailable after retries,
    try GEN_FALLBACK_MODEL once. Non-retryable errors (bad prompt, blocked
    content) raise immediately — callers decide how to degrade."""
    try:
        return call_with_retry(
            lambda: build_response(GEN_MODEL),
            max_retries=GEN_MAX_RETRIES,
            max_backoff=GEN_MAX_BACKOFF,
        )
    except Exception as exc:  # noqa: BLE001 - only fall back on quota/server errors
        if not GEN_FALLBACK_MODEL or GEN_FALLBACK_MODEL == GEN_MODEL or not is_retryable(exc):
            raise
        print(f"{GEN_MODEL} still failing after retries ({exc}); trying {GEN_FALLBACK_MODEL}")
        return call_with_retry(
            lambda: build_response(GEN_FALLBACK_MODEL),
            max_retries=2,
            max_backoff=GEN_MAX_BACKOFF,
        )


def _brev_ready() -> bool:
    return bool(BREV_BASE_URL and BREV_API_KEY)


def _call_brev(system: str, user: str, *, max_tokens: int, json_mode: bool) -> str:
    """One chat completion against the Brev vLLM server."""
    payload: dict = {
        "model": BREV_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.0 if json_mode else 0.2,
        "max_tokens": max_tokens,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    with httpx.Client(timeout=180.0) as client:
        res = client.post(
            f"{BREV_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {BREV_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
    if res.status_code >= 400:
        raise RuntimeError(f"brev {res.status_code}: {res.text[:300]}")
    content = res.json()["choices"][0]["message"].get("content") or ""
    return content.strip()


def _call_form_model(
    system: str,
    user: str,
    gemini_build: Callable[[str], str],
    *,
    max_tokens: int,
    json_mode: bool,
) -> str:
    """Form retrospect goes to Brev when configured. A down GPU falls through
    to Gemini so chat still answers."""
    if _brev_ready():
        try:
            text_value = _call_brev(system, user, max_tokens=max_tokens, json_mode=json_mode)
            if text_value:
                return text_value
        except Exception as exc:  # noqa: BLE001
            print(f"Brev form call failed, falling back to Gemini: {exc}")
    return _call_gemini(gemini_build)


_SYSTEM = (
    "You are Athena, an internal knowledge assistant for a company. "
    "Answer the employee's question in plain, everyday language using ONLY the "
    "document excerpt provided. Be concise — 1 to 3 short sentences, or a few "
    "bullet points if the answer is a list. Translate legal, technical, or "
    "corporate jargon into simple terms a normal person understands. "
    "Do not add information that is not in the excerpt, and do not quote code or "
    "reference numbers unless the user asked for them. If the excerpt does not "
    "actually answer the question, say so plainly in one sentence."
)


def _build_config(system: str = _SYSTEM) -> types.GenerateContentConfig:
    kwargs = dict(
        system_instruction=system,
        temperature=0.2,
        max_output_tokens=800,
    )
    # gemini-2.5-* are thinking models: reasoning tokens count against
    # max_output_tokens, so the visible answer gets truncated mid-sentence.
    # A short grounded answer needs no thinking — turn it off (also faster).
    # Guarded so older SDKs without ThinkingConfig still work.
    try:
        kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
    except Exception:  # noqa: BLE001
        pass
    return types.GenerateContentConfig(**kwargs)


def _history_block(history: list[dict] | None, limit: int = 6) -> str:
    """Render the last `limit` turns as a compact transcript for prompting."""
    if not history:
        return ""
    recent = history[-limit:]
    lines = []
    for turn in recent:
        who = "User" if turn.get("role") == "user" else "Athena"
        lines.append(f"{who}: {turn.get('content', '').strip()}")
    return "\n".join(lines)


def _generate_sync(query: str, chunk_text: str, history: list[dict] | None) -> str:
    convo = _history_block(history)
    convo_section = f"Conversation so far:\n{convo}\n\n" if convo else ""
    prompt = (
        f"{convo_section}"
        f"Current question: {query}\n\n"
        f'Document excerpt:\n"""\n{chunk_text}\n"""\n\n'
        "Answer:"
    )
    config = _build_config()

    def build(model: str) -> str:
        resp = _client.models.generate_content(model=model, contents=prompt, config=config)
        return (resp.text or "").strip()

    return _call_gemini(build)


async def synthesize_answer(
    query: str, chunk_text: str, history: list[dict] | None = None
) -> tuple[str, bool]:
    """Plain-language answer grounded on chunk_text, aware of prior turns. Never
    raises — on failure it returns the raw chunk so the user still gets material.
    Returns (answer, degraded) — degraded is True when Gemini (both the primary
    and fallback model) failed and the raw chunk was returned instead, so the
    caller can tell the user why the answer looks unpolished."""
    try:
        answer = await asyncio.to_thread(_generate_sync, query, chunk_text, history)
        return (answer, False) if answer else (chunk_text, True)
    except Exception as exc:  # noqa: BLE001 - degrade gracefully, never break chat
        print(f"Answer synthesis failed, returning raw chunk: {exc}")
        return chunk_text, True


_FORM_SYSTEM = (
    "You are Athena, an internal knowledge assistant for a company. The "
    "employee asked a question about a form or survey, and you have been given "
    "a real aggregate breakdown of every response to the matching question — "
    "not one respondent's answer. Answer using ONLY the breakdown. "
    "When the breakdown includes a sentiment line and issues or individual "
    "answers, lead with the overall tone using those counts, then the top "
    "three issues. Each issue gets its count, when a count is given, and one "
    "short quote copied from the breakdown. "
    "When the breakdown is choice counts or a numeric summary, name the most "
    "common answer or state the average in 1 to 3 short sentences. "
    "Never invent a response, count, or percentage that is not in the "
    "breakdown, and never present a single line item as the whole picture "
    "if the breakdown lists several. If the breakdown does not actually answer "
    "the question, say so plainly."
)


def _generate_form_sync(query: str, question_label: str, breakdown: str, history: list[dict] | None) -> str:
    convo = _history_block(history)
    convo_section = f"Conversation so far:\n{convo}\n\n" if convo else ""
    prompt = (
        f"{convo_section}"
        f"Current question: {query}\n\n"
        f'Matching form question: "{question_label}"\n\n'
        f"Breakdown of responses:\n{breakdown}\n\n"
        "Answer:"
    )
    config = _build_config(_FORM_SYSTEM)

    def build(model: str) -> str:
        resp = _client.models.generate_content(model=model, contents=prompt, config=config)
        return (resp.text or "").strip()

    return _call_form_model(_FORM_SYSTEM, prompt, build, max_tokens=700, json_mode=False)


async def synthesize_form_answer(
    query: str, question_label: str, breakdown: str, history: list[dict] | None = None
) -> tuple[str, bool]:
    """Plain-language answer grounded on a real aggregate breakdown (SQL counts
    or clustered themes), not one respondent's wording. Never raises — on
    failure it returns the raw breakdown so the user still gets the real data.
    Returns (answer, degraded) — see synthesize_answer."""
    try:
        answer = await asyncio.to_thread(_generate_form_sync, query, question_label, breakdown, history)
        return (answer, False) if answer else (breakdown, True)
    except Exception as exc:  # noqa: BLE001 - degrade gracefully, never break chat
        print(f"Form answer synthesis failed, returning raw breakdown: {exc}")
        return breakdown, True


_CONDENSE_SYSTEM = (
    "You rewrite a follow-up question into a standalone search query. Given the "
    "conversation so far and a follow-up, output a single self-contained question "
    "that includes the subject the follow-up refers to, so it can be searched "
    "without the conversation. Output ONLY the rewritten question, nothing else. "
    "If the follow-up is already self-contained, return it unchanged."
)


def _condense_sync(query: str, history: list[dict]) -> str:
    convo = _history_block(history)
    prompt = f"Conversation so far:\n{convo}\n\nFollow-up: {query}\n\nStandalone question:"
    kwargs = dict(
        system_instruction=_CONDENSE_SYSTEM,
        temperature=0.0,
        max_output_tokens=120,
    )
    try:
        kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
    except Exception:  # noqa: BLE001
        pass
    config = types.GenerateContentConfig(**kwargs)

    def build(model: str) -> str:
        resp = _client.models.generate_content(model=model, contents=prompt, config=config)
        return (resp.text or "").strip()

    return _call_gemini(build)


async def condense_question(query: str, history: list[dict] | None) -> str:
    """Turn a context-dependent follow-up ("how much notice?") into a standalone
    query ("how much notice is required for leave?") for retrieval. Falls back to
    the raw query on any failure or when there is no history."""
    if not history:
        return query
    try:
        rewritten = await asyncio.to_thread(_condense_sync, query, history)
        return rewritten or query
    except Exception as exc:  # noqa: BLE001
        print(f"Follow-up condense failed, using raw query: {exc}")
        return query


# ---------------------------------------------------------------------------
# Form theme labelling + sentiment
# ---------------------------------------------------------------------------

_THEME_SYSTEM = (
    "You name recurring themes in survey free-text answers. Given a question and "
    "a sample of answers that were grouped together by meaning, reply with JSON "
    'only: {"label": "...", "summary": "..."}. The label is a short noun phrase '
    "naming what these answers have in common — 2 to 5 words, sentence case, no "
    "trailing punctuation, specific rather than generic (\"flaky integration "
    "tests\" not \"testing issues\"). The summary is one plain sentence describing "
    "what respondents said. Use only what is in the answers; do not invent detail "
    "and do not state counts or proportions."
)

_SENTIMENT_SYSTEM = (
    "You classify the sentiment of survey free-text answers. For each numbered "
    "answer, decide whether the respondent's tone toward the thing they are "
    "describing is positive, negative, or neutral. Neutral covers factual or "
    "purely descriptive answers with no evaluative charge. Reply with JSON only, "
    'as an object: {"labels": [{"i": 1, "s": "negative"}, {"i": 2, "s": "neutral"}]}. '
    "Include exactly one entry per numbered answer, using only those three values."
)


def _json_only_config(system: str, max_tokens: int) -> types.GenerateContentConfig:
    kwargs = dict(
        system_instruction=system,
        temperature=0.0,
        max_output_tokens=max_tokens,
        response_mime_type="application/json",
    )
    try:
        kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
    except Exception:  # noqa: BLE001
        pass
    return types.GenerateContentConfig(**kwargs)


def _parse_json(raw: str):
    """Tolerate a fenced or prose-wrapped response even with a JSON mime type."""
    text_value = (raw or "").strip()
    if text_value.startswith("```"):
        text_value = text_value.strip("`")
        text_value = text_value.split("\n", 1)[-1] if "\n" in text_value else text_value
    start = min((i for i in (text_value.find("{"), text_value.find("[")) if i != -1), default=-1)
    if start == -1:
        raise ValueError("no JSON in response")
    end = max(text_value.rfind("}"), text_value.rfind("]"))
    return json.loads(text_value[start:end + 1])


def _label_theme_sync(question: str, samples: list[str]) -> dict:
    listed = "\n".join(f"- {s}" for s in samples)
    prompt = f"Question: {question}\n\nAnswers grouped together:\n{listed}\n\nJSON:"
    config = _json_only_config(_THEME_SYSTEM, 300)

    def build(model: str) -> str:
        resp = _client.models.generate_content(model=model, contents=prompt, config=config)
        return resp.text or ""

    data = _parse_json(_call_form_model(_THEME_SYSTEM, prompt, build, max_tokens=300, json_mode=True))
    return {
        "label": str(data.get("label", "")).strip()[:120],
        "summary": str(data.get("summary", "")).strip()[:600],
    }


async def label_theme(question: str, samples: list[str]) -> dict:
    """Name a cluster of answers. Falls back to a truncated representative answer
    so an unlabelled theme still reads as something rather than blank."""
    if not samples:
        return {"label": "", "summary": ""}
    try:
        result = await asyncio.to_thread(_label_theme_sync, question, samples)
        if result["label"]:
            return result
    except Exception as exc:  # noqa: BLE001
        print(f"  Theme labelling failed, using fallback: {exc}")
    fallback = samples[0].strip().replace("\n", " ")
    return {"label": fallback[:60] or "Unlabelled", "summary": ""}


def _sentiment_sync(texts: list[str]) -> list[str]:
    listed = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(texts))
    contents = f"Answers:\n{listed}\n\nJSON:"
    config = _json_only_config(_SENTIMENT_SYSTEM, 40 * len(texts) + 200)

    def build(model: str) -> str:
        resp = _client.models.generate_content(model=model, contents=contents, config=config)
        return resp.text or ""

    data = _parse_json(_call_form_model(_SENTIMENT_SYSTEM, contents, build, max_tokens=40 * len(texts) + 200, json_mode=True))

    allowed = {"positive", "negative", "neutral"}
    out = ["neutral"] * len(texts)
    items = data if isinstance(data, list) else []
    if isinstance(data, dict):
        for key in ("labels", "results", "sentiments"):
            if isinstance(data.get(key), list):
                items = data[key]
                break
    for item in items:
        try:
            idx = int(item.get("i", 0)) - 1
        except (TypeError, ValueError):
            continue
        value = str(item.get("s", "")).lower().strip()
        if 0 <= idx < len(out) and value in allowed:
            out[idx] = value
    return out


_STARTER_SYSTEM = (
    "You write starter questions for an internal company knowledge chat. "
    "You are given short excerpts from this organisation's own documents. "
    "Output JSON only: {\"questions\": [\"...\", \"...\"]}. "
    "Write 4 questions a staff member would actually type. Each question MUST "
    "be answerable from the excerpts — names, processes, policies, or facts "
    "that appear there. Prefer uploaded files when those excerpts are present. "
    "Keep each question under 90 characters. Ask about the topic or rule, not "
    "the full document filename. Do not paste long titles into the question. "
    "Be specific. Do not invent generic HR/IT questions (expense claims, leave "
    "policy, IT access) unless those topics are in the excerpts. Sentence case, "
    "no numbering, no quotes around the questions."
)


def _starter_questions_sync(excerpts: list[dict]) -> list[str]:
    blocks = []
    for i, item in enumerate(excerpts, start=1):
        source = item.get("source_type") or "doc"
        title = (item.get("title") or "Untitled").strip()
        if len(title) > 60:
            title = title[:57].rsplit(" ", 1)[0].rstrip(" -_.,") + "…"
        text = (item.get("excerpt") or "").strip()
        blocks.append(f"[{i} | {source} | {title}]\n{text}")
    prompt = "Excerpts:\n\n" + "\n\n".join(blocks) + "\n\nJSON:"
    kwargs = dict(
        system_instruction=_STARTER_SYSTEM,
        temperature=0.3,
        max_output_tokens=400,
        response_mime_type="application/json",
    )
    try:
        kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
    except Exception:  # noqa: BLE001
        pass
    config = types.GenerateContentConfig(**kwargs)

    def build(model: str) -> str:
        resp = _client.models.generate_content(model=model, contents=prompt, config=config)
        return resp.text or ""

    data = _parse_json(_call_gemini(build))
    raw = data.get("questions") if isinstance(data, dict) else data
    out: list[str] = []
    seen: set[str] = set()
    for item in raw if isinstance(raw, list) else []:
        q = " ".join(str(item).split()).strip().rstrip("?") + "?"
        key = q.lower()
        if len(q) < 12 or key in seen:
            continue
        seen.add(key)
        if len(q) > 90:
            cut = q[:87].rsplit(" ", 1)[0].rstrip(" ?.,;:")
            q = (cut or q[:87]).rstrip("?") + "?"
        out.append(q)
        if len(out) >= 6:
            break
    return out


async def suggest_starter_questions(excerpts: list[dict]) -> list[str]:
    """Questions grounded on the given excerpts. Empty list on failure — never
    invent a generic fallback set; the UI should show no chips rather than
    questions the corpus cannot answer."""
    if not excerpts:
        return []
    try:
        return await asyncio.to_thread(_starter_questions_sync, excerpts)
    except Exception as exc:  # noqa: BLE001
        print(f"Starter question generation failed: {exc}")
        return []


async def classify_sentiment(texts: list[str]) -> list[str]:
    """Sentiment per answer, batched. Returns one label per input, defaulting to
    "neutral" — a failed batch must not drop answers or shift the alignment
    between inputs and results."""
    if not texts:
        return []
    try:
        return await asyncio.to_thread(_sentiment_sync, texts)
    except Exception as exc:  # noqa: BLE001
        print(f"  Sentiment classification failed, defaulting to neutral: {exc}")
        return ["neutral"] * len(texts)
