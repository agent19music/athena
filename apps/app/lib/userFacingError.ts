/** Plain sentences for the product UI. Never surface SQL, stack traces, or provider payloads. */
export function userFacingError(
  raw: string | null | undefined,
  fallback = "Something went wrong. Try again.",
): string {
  if (!raw) return fallback;
  const text = raw.toLowerCase();
  if (text.includes("row-level security") || text.includes("insufficientprivilege")) {
    return "Form responses couldn't be saved. Try syncing again.";
  }
  if (
    text.includes("resource_exhausted") ||
    text.includes("quota") ||
    text.includes("rate limit") ||
    text.includes("rate-limit") ||
    text.includes("429")
  ) {
    return "Indexing is paused because the service is busy. Try again in a few minutes.";
  }
  if (text.includes("password") && text.includes("pdf")) {
    return "This PDF is password-protected.";
  }
  if (text.includes("exceeds") && text.includes("mb")) {
    return "This file is over the 25 MB limit.";
  }
  if (text.includes("no extractable text") || text.includes("no readable text")) {
    return "This file has no readable text.";
  }
  if (text.includes("unsupported type")) {
    return "This file type isn't supported.";
  }
  if (text.includes("payload") || text.includes("entity too large") || text.includes("413")) {
    return "This file is too large to upload. Files up to 25 MB are supported.";
  }
  if (text.includes("plan limit") || text.includes("upgrade")) {
    return raw.length > 180 ? "Plan limit reached. Upgrade on Billing." : raw;
  }
  if (
    raw.length <= 160 &&
    !text.includes("psycopg") &&
    !text.includes("traceback") &&
    !text.includes("sql:") &&
    !raw.includes("{")
  ) {
    return raw;
  }
  return fallback;
}
