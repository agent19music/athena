"""Short copy for API clients. Full exceptions stay in logs and the database."""


def public_error(raw: str | None, fallback: str = "Something went wrong. Try again.") -> str:
    if not raw:
        return fallback
    text = raw.lower()
    if "row-level security" in text or "insufficientprivilege" in text:
        return "Form responses couldn't be saved. Try syncing again."
    if (
        "resource_exhausted" in text
        or "quota" in text
        or "rate limit" in text
        or "rate-limit" in text
        or " 429" in text
        or text.startswith("429")
    ):
        return "Indexing is paused because the service is busy. Try again in a few minutes."
    if "password" in text and "pdf" in text:
        return "This PDF is password-protected."
    if "exceeds" in text and "mb" in text:
        return "This file is over the 25 MB limit."
    if "no extractable text" in text or "no readable text" in text:
        return "This file has no readable text."
    if "unsupported type" in text:
        return "This file type isn't supported."
    if "couldn't read this pdf" in text or "couldn't read this file" in text:
        return "This file couldn't be read. Try another copy."
    if len(raw) <= 160 and "psycopg" not in text and "traceback" not in text and "sql:" not in text and "{" not in raw:
        return raw
    return fallback
