import { userFacingError } from "./userFacingError";

/**
 * Post file bytes straight at the API.
 *
 * The Next.js route on Vercel rejects bodies around 4.5 MB before the function
 * runs, so a larger PDF never reached Render and never showed up in logs or
 * Sentry. GET /api/upload only returns the backend URL; the file itself does not
 * pass through Vercel.
 */
const PROXY_SAFE_BYTES = 4 * 1024 * 1024;

export async function uploadToBackend(
  form: FormData,
  token: string | null,
  bytes: number,
): Promise<Response> {
  const metaRes = await fetch("/api/upload", { cache: "no-store" });
  const meta = metaRes.ok ? await metaRes.json().catch(() => null) : null;
  const url = typeof meta?.url === "string" ? meta.url : "";

  if (url && token) {
    return fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  }

  if (bytes > PROXY_SAFE_BYTES) {
    throw new Error("This file is too large to upload through the app. Try again in a moment.");
  }

  return fetch("/api/upload", { method: "POST", body: form });
}

export function uploadFailureReason(
  status: number,
  data: { detail?: unknown; error?: string } | null,
): string {
  const detail = data?.detail;
  const raw =
    (typeof detail === "object" && detail !== null && "message" in detail
      ? String((detail as { message?: unknown }).message ?? "")
      : "") ||
    (typeof detail === "string" ? detail : "") ||
    data?.error ||
    (status === 413 ? "payload too large" : "") ||
    (status === 402 ? "Plan limit reached. Upgrade on Billing." : "");

  return userFacingError(
    raw,
    status === 402
      ? "Plan limit reached. Upgrade on Billing."
      : "Couldn't index this file. Try again.",
  );
}
