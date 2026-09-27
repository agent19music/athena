"use client";

import Image from "next/image";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { userFacingError } from "@/lib/userFacingError";
import type { ConnectorState } from "./page";

type Status = "connected" | "partial" | "disconnected" | "syncing" | "error" | "soon";

// Waits for one ingestion run to leave "running". A sync is a background task
// behind a 202, so without this the UI reads connection state while indexing is
// still in flight and shows the pre-sync status — the reason configuring a
// connector used to appear to do nothing until a manual hard refresh.
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000;

type JobOutcome = { status: "completed" | "failed" | "timeout"; error?: string | null; chunks?: number };

async function waitForJob(jobId: string): Promise<JobOutcome> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`/api/admin/sync?job_id=${encodeURIComponent(jobId)}`, { cache: "no-store" });
      if (!res.ok) continue; // transient — keep polling until the deadline
      const job = await res.json();
      if (job.status === "completed") return { status: "completed", chunks: job.chunks };
      if (job.status === "failed") {
        return { status: "failed", error: userFacingError(job.error, "The sync failed. Try again.") };
      }
    } catch {
      /* network blip — keep polling */
    }
  }

  // Still running. The job itself is unaffected; we just stop watching.
  return { status: "timeout" };
}

type OrgStats = {
  chunk_count: number;
  last_synced: string | null;
  source_types: string[];
  plan?: string;
  limits?: { drive?: boolean; source_types?: number | null };
};
type Job = {
  id: string;
  status: string;
  trigger: string;
  documents: number;
  chunks: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
};

type Connection = {
  id: string;
  name: string;
  description: string;
  status: Status;
  meta: string;
  actionLabel: string;
  actionHref?: string;
  /** Primary OAuth connect for Tally (no pasted API key). */
  oauthHref?: string;
  oauthLabel?: string;
  syncable: boolean;
  logo: React.ReactNode;
};

const NotionLogo = () => (
  <svg width="22" height="22" viewBox="0 0 100 100" fill="none">
    <path d="M6.017 4.313l55.333-4.087c6.797-.583 8.543-.19 12.817 2.917l17.663 12.443c2.913 2.14 3.883 2.723 3.883 5.053v68.243c0 4.277-1.553 6.807-6.99 7.193L24.467 99.967c-4.08.193-6.023-.39-8.16-3.113L3.3 79.94c-2.333-3.113-3.3-5.443-3.3-8.167V11.113c0-3.497 1.553-6.413 6.017-6.8z" fill="#fff"/>
    <path fillRule="evenodd" clipRule="evenodd" d="M61.35.227l-55.333 4.087C1.553 4.7 0 7.617 0 11.113v60.66c0 2.723.967 5.053 3.3 8.167l13.007 16.913c2.137 2.723 4.08 3.307 8.16 3.113l64.257-3.89c5.433-.387 6.99-2.917 6.99-7.193V20.64c0-2.21-.873-2.847-3.443-4.733L74.167 3.143c-4.273-3.107-6.02-3.5-12.817-2.917zM25.92 19.523c-5.247.353-6.437.433-9.417-1.99L8.927 11.507c-.77-.78-.383-1.753 1.557-1.947l53.193-3.887c4.467-.39 6.793 1.167 8.54 2.527l9.123 6.61c.39.197 1.36 1.36.193 1.36l-54.93 3.307-.683.047zM19.803 88.3V30.367c0-2.53.777-3.697 3.103-3.893L86 22.78c2.14-.193 3.107 1.167 3.107 3.693v57.547c0 2.53-.39 4.67-3.883 4.863l-60.377 3.5c-3.493.193-5.043-.97-5.043-4.083zm59.6-54.827c.387 1.75 0 3.5-1.75 3.7l-2.91.577v42.773c-2.527 1.36-4.853 2.137-6.797 2.137-3.107 0-3.883-.973-6.21-3.887l-19.03-29.94v28.967l6.077 1.36s0 3.5-4.853 3.5l-13.39.777c-.39-.78 0-2.723 1.357-3.11l3.497-.97v-38.3L30.48 40.667c-.39-1.75.58-4.277 3.3-4.473l14.367-.967 19.8 30.327v-26.83l-5.047-.58c-.39-2.143 1.163-3.7 3.103-3.89l13.4-.78z" fill="#000"/>
  </svg>
);




const STATUS_CONFIG: Record<Status, { label: string; dot: string; bg: string; text: string }> = {
  connected: { label: "Connected", dot: "#22c55e", bg: "#f0fdf4", text: "#15803d" },
  syncing: { label: "Syncing", dot: "#3b82f6", bg: "#eff6ff", text: "#1d4ed8" },
  // "Partial" now means only one thing: credentials are stored but the run
  // indexed nothing (bad key, empty form, revoked access). A connector with no
  // credentials is "Not connected".
  partial: { label: "Nothing indexed", dot: "#f59e0b", bg: "#fffbeb", text: "#b45309" },
  error: { label: "Last sync failed", dot: "#ef4444", bg: "#fef2f2", text: "#b91c1c" },
  disconnected: { label: "Not connected", dot: "#d1d5db", bg: "#f9fafb", text: "#6b7280" },
  soon: { label: "Coming soon", dot: "#c4b5fd", bg: "#f5f3ff", text: "#7c3aed" },
};

// Row order: anything already wired up (even if its last run had trouble)
// outranks connectors that still need setup, which outrank ones that aren't
// buildable yet — so the sources actually in use surface first.
const STATUS_RANK: Record<Status, number> = {
  connected: 0,
  syncing: 0,
  partial: 0,
  error: 0,
  disconnected: 1,
  soon: 2,
};

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

// A shared button that hits the real /api/admin/sync route and refreshes server
// data so the status/chunk-count reflect the new run.
function SyncButton({ body, label = "Sync now" }: { body?: Record<string, unknown>; label?: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "syncing" | "done" | "error">("idle");

  async function sync() {
    setState("syncing");
    try {
      const res = await fetch("/api/admin/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) throw new Error(await res.text());

      // Wait for the background run to settle before refreshing, so the row
      // reflects the sync that just happened rather than the state before it.
      const { job_id: jobId } = await res.json();
      const outcome = jobId ? await waitForJob(jobId) : { status: "completed" as const };

      router.refresh();
      setState(outcome.status === "failed" ? "error" : "done");
      setTimeout(() => setState("idle"), outcome.status === "failed" ? 4000 : 3000);
    } catch (err) {
      console.error("Sync failed:", err);
      setState("error");
      setTimeout(() => setState("idle"), 4000);
    }
  }

  const text =
    state === "syncing" ? "Syncing…" : state === "done" ? "✓ Done" : state === "error" ? "Retry" : label;

  return (
    <Button
      onClick={sync}
      disabled={state === "syncing"}
      variant={state === "error" ? "destructive" : "primary-dark"}
      size="sm"
      className="tooltip tooltip-end"
      data-tooltip="Trigger manual sync instantly"
    >
      {text}
    </Button>
  );
}

// Per-connector setup, described as data so the modal stays generic. `list`
// fields are typed comma-separated and sent as an array (what the backend's
// ingest config expects for form/doc id collections).
type Field = {
  key: string;
  label: string;
  hint: string;
  placeholder: string;
  secret?: boolean;
  list?: boolean;
  optional?: boolean;
};

const CONNECTOR_FIELDS: Record<string, { title: string; blurb: string; docs: string; fields: Field[] }> = {
  notion: {
    title: "Configure Notion",
    blurb:
      "Prefer Connect Notion (OAuth) on the row — share pages during Notion consent, no token paste. Advanced: paste an internal integration token and root page id.",
    docs: "https://developers.notion.com/docs/authorization",
    fields: [
      {
        key: "notion_api_key",
        label: "Integration token (advanced)",
        hint: "Only if you are not using Connect Notion. Starts with secret_ or ntn_.",
        placeholder: "ntn_…",
        secret: true,
        optional: true,
      },
      {
        key: "notion_root_page_id",
        label: "Root page id",
        hint: "Page shared with Athena. After OAuth you can pick from the dropdown below when available.",
        placeholder: "1a2b3c4d…",
      },
    ],
  },
  tally: {
    title: "Configure Tally",
    blurb:
      "Prefer Connect Tally (OAuth) on the row — no API key paste. Advanced: paste a personal access token and form ids. Each submission is indexed as its own document.",
    docs: "https://developers.tally.so/api-reference/mcp",
    fields: [
      {
        key: "tally_api_key",
        label: "API key (advanced)",
        hint: "Only if you are not using Connect Tally. Personal access token from Tally settings.",
        placeholder: "tly_…",
        secret: true,
        optional: true,
      },
      {
        key: "tally_form_ids",
        label: "Form ids",
        hint: "Comma separated. After OAuth, Athena tries to detect forms automatically; override here if needed.",
        placeholder: "wA2xR9, mBv7Kd",
        list: true,
      },
    ],
  },
  drive: {
    title: "Set up Google Drive",
    blurb: "Share the folder with the Athena service account as a Viewer first, then paste its id here.",
    docs: "",
    fields: [
      {
        key: "drive_folder_id",
        label: "Folder id",
        hint: "The trailing segment of the folder URL, after /folders/.",
        placeholder: "1AbC…",
      },
    ],
  },
};

function ConnectorModal({
  connectorId,
  configured,
  onClose,
}: {
  connectorId: string;
  configured: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const spec = CONNECTOR_FIELDS[connectorId];
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<"idle" | "saving" | "syncing" | "error">("idle");
  const [error, setError] = useState("");
  const [notionPages, setNotionPages] = useState<Array<{ id: string; title: string }>>([]);

  useEffect(() => {
    if (connectorId !== "notion") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/notion/pages", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.pages)) {
          setNotionPages(
            data.pages.map((p: { id: string; title: string }) => ({
              id: p.id,
              title: p.title || p.id,
            })),
          );
        }
      } catch {
        /* optional enhancement */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectorId]);

  const busy = state === "saving" || state === "syncing";
  const ready =
    connectorId === "notion"
      ? Boolean((values.notion_root_page_id ?? "").trim())
      : spec.fields.every((f) => f.optional || (values[f.key] ?? "").trim());

  async function save() {
    setState("saving");
    setError("");

    const body: Record<string, unknown> = {};
    for (const f of spec.fields) {
      const raw = (values[f.key] ?? "").trim();
      if (!raw) continue;
      body[f.key] = f.list ? raw.split(",").map((v) => v.trim()).filter(Boolean) : raw;
    }

    try {
      // OAuth-connected Notion with only a root page selected → dedicated endpoint.
      if (
        connectorId === "notion" &&
        typeof body.notion_root_page_id === "string" &&
        !body.notion_api_key
      ) {
        const res = await fetch("/api/admin/notion/root", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            root_page_id: body.notion_root_page_id,
            trigger_ingest: true,
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || payload.detail || "Could not save root page");
        const jobId = payload.job_id;
        if (jobId) {
          setState("syncing");
          const outcome = await waitForJob(jobId);
          if (outcome.status === "failed") {
            setError(outcome.error || "The sync failed.");
            setState("error");
            router.refresh();
            return;
          }
        }
        router.refresh();
        onClose();
        return;
      }

      const res = await fetch("/api/admin/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Could not save");
      }

      // Credentials are saved at this point, but indexing runs in the
      // background. Hold the modal open until the run settles so the user sees
      // the outcome here instead of closing onto a stale "Not connected" row.
      const jobId = payload.job_id;
      if (jobId) {
        setState("syncing");
        const outcome = await waitForJob(jobId);

        if (outcome.status === "failed") {
          setError(outcome.error || "The sync failed. Check the credentials and try again.");
          setState("error");
          router.refresh();
          return;
        }
        if (outcome.status === "timeout") {
          // Still indexing — closing is safe, the row picks it up on next load.
          router.refresh();
          onClose();
          return;
        }
      }
      router.refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setState("error");
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        backdropFilter: "blur(2px)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={spec.title}
        style={{
          background: "#fff",
          borderRadius: 16,
          width: 480,
          maxWidth: "calc(100vw - 32px)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "24px 28px 20px",
            borderBottom: "1px solid #F0F0F0",
          }}
        >
          <h2 style={{ fontSize: 20, fontWeight: 400, letterSpacing: "-0.02em", color: "#111", margin: 0 }}>
            {spec.title}
          </h2>
          <Button
            onClick={onClose}
            aria-label="Close"
            variant="ghost"
            size="icon-lg"
            style={{ fontSize: 20, color: "#ccc", lineHeight: 1 }}
          >
            ×
          </Button>
        </div>

        <div style={{ padding: "20px 28px 24px" }}>
          <p style={{ fontSize: 13.5, color: "#888", lineHeight: 1.6, margin: "0 0 20px" }}>
            {spec.blurb}
            {spec.docs && (
              <>
                {" "}
                <a
                  href={spec.docs}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#2563EB", textDecoration: "none" }}
                >
                  Where do I find this?
                </a>
              </>
            )}
          </p>

          {configured && (
            <p className="notice notice-warning" style={{ margin: "0 0 20px" }}>
              Already connected. Saving replaces the stored credentials and re-indexes.
            </p>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {connectorId === "notion" && notionPages.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label htmlFor="notion_page_picker" style={{ fontSize: 13, color: "#444" }}>
                  Pages shared with Athena
                </label>
                <select
                  id="notion_page_picker"
                  value={values.notion_root_page_id ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, notion_root_page_id: e.target.value }))
                  }
                  style={{
                    fontSize: 13.5,
                    color: "#111",
                    background: "#fff",
                    border: "1px solid #E2E2E2",
                    borderRadius: 8,
                    padding: "10px 12px",
                  }}
                >
                  <option value="">Select a root page…</option>
                  {notionPages.map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {spec.fields.map((f) => (
              <div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label htmlFor={f.key} style={{ fontSize: 13, color: "#444" }}>
                  {f.label}
                </label>
                <input
                  id={f.key}
                  type={f.secret ? "password" : "text"}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  autoComplete="off"
                  style={{
                    fontSize: 13.5,
                    color: "#111",
                    background: "#fff",
                    border: "1px solid #E2E2E2",
                    borderRadius: 8,
                    padding: "10px 12px",
                    outline: "none",
                    width: "100%",
                    transition: "border-color 150ms",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "#111")}
                  onBlur={(e) => (e.target.style.borderColor = "#E2E2E2")}
                />
                <span style={{ fontSize: 12, color: "#aaa", lineHeight: 1.5 }}>{f.hint}</span>
              </div>
            ))}
          </div>

          {error && (
            <p style={{ fontSize: 12.5, color: "#b91c1c", margin: "16px 0 0", lineHeight: 1.5 }}>{error}</p>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 24 }}>
            <Button onClick={onClose} variant="ghost">
              {state === "syncing" ? "Close and keep syncing" : "Cancel"}
            </Button>
            <Button onClick={save} disabled={!ready || busy} variant="primary-dark">
              {state === "saving" ? "Saving…" : state === "syncing" ? "Indexing…" : "Save and sync"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Records real interest in a not-yet-shipped connector via /api/admin/notify
// (backend: integration_interest table) so there's an actual list to email
// once it ships, instead of a click that only flips local React state.
function NotifyButton({ integration, initiallyNotified }: { integration: string; initiallyNotified: boolean }) {
  const { user } = useUser();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    initiallyNotified ? "done" : "idle"
  );

  async function notify() {
    setState("loading");
    try {
      const res = await fetch("/api/admin/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integration,
          email: user?.primaryEmailAddress?.emailAddress,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setState("done");
    } catch (err) {
      console.error("Notify signup failed:", err);
      setState("error");
      setTimeout(() => setState("idle"), 4000);
    }
  }

  const label =
    state === "loading" ? "Saving…" : state === "done" ? "✓ Noted" : state === "error" ? "Retry" : "Notify me";

  return (
    <Button
      onClick={notify}
      disabled={state === "loading" || state === "done"}
      variant={state === "error" ? "destructive" : "accent-solid"}
      size="sm"
    >
      {label}
    </Button>
  );
}

// Opens the connector's setup modal. Styled to match the plain action links it
// replaced, so the row layout stays a single button per connector. Once a
// connector already has credentials, re-opening this modal replaces them —
// destructive styling plus a tooltip make that consequence visible before the
// click, instead of only inside the modal's warning copy.
function ConfigureButton({
  label,
  destructive,
  tooltip,
  onClick,
}: {
  label: string;
  destructive?: boolean;
  tooltip?: string;
  onClick: () => void;
}) {
  return (
    <Button
      onClick={onClick}
      variant={destructive ? "destructive" : "primary-dark"}
      size="sm"
      className={tooltip ? "tooltip tooltip-end" : undefined}
      data-tooltip={tooltip}
    >
      {label}
    </Button>
  );
}

export default function ConnectionsClient({
  stats,
  jobs,
  notifiedIntegrations,
  connectors,
}: {
  stats: OrgStats | null;
  jobs: Job[];
  notifiedIntegrations: string[];
  connectors: Record<string, ConnectorState>;
}) {
  const router = useRouter();
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [dismissedJobErrorId, setDismissedJobErrorId] = useState<string | null>(null);
  const driveAllowed = stats?.limits?.drive === true || stats?.plan === "pro" || stats?.plan === "plus" || stats?.plan === "advanced";

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tally = params.get("tally");
    const notion = params.get("notion");
    if (tally === "connected") {
      const n = params.get("forms");
      setBanner(
        n
          ? `Tally connected. Syncing ${n} form${n === "1" ? "" : "s"}.`
          : "Tally connected.",
      );
    } else if (tally === "pick_forms" || tally === "no_forms") {
      setBanner("Tally authorized. Add form ids under Advanced to start indexing.");
      setConfiguring("tally");
    } else if (tally === "error") {
      setBanner(`Tally connect failed (${params.get("reason") || "unknown"}). Try again.`);
    }

    if (notion === "connected") {
      const ws = params.get("workspace");
      setBanner(ws ? `Notion connected (${ws}). Syncing…` : "Notion connected. Syncing…");
    } else if (notion === "pick_root" || notion === "no_pages") {
      setBanner(
        notion === "no_pages"
          ? "Notion authorized, but no pages were shared. Share pages with Athena in Notion, then pick a root."
          : "Notion authorized. Pick a root page to start indexing.",
      );
      setConfiguring("notion");
    } else if (notion === "error") {
      setBanner(`Notion connect failed (${params.get("reason") || "unknown"}). Try again.`);
    }
  }, []);

  const lastSynced = stats?.last_synced ?? null;
  const latestJob = jobs[0] ?? null;

  // Status comes from the backend's per-connector view, which knows whether
  // credentials are stored. Deriving it from indexed chunk types (as this page
  // used to) can't tell "never set up" apart from "set up but nothing indexed",
  // so an unconfigured connector was reported as partially connected.
  const stateFor = (id: string): ConnectorState =>
    connectors[id] ?? { configured: false, status: "disconnected", chunk_count: 0, last_synced: null, has_forms: false, has_root: false, oauth: false };

  // Row subtitle, driven by the connector's real state rather than a single
  // "has data / has no data" fork.
  const metaFor = (id: string, notConfiguredHint: string): string => {
    const s = stateFor(id);
    switch (s.status) {
      case "connected":
        return `${s.chunk_count.toLocaleString()} chunks · last synced ${relativeTime(s.last_synced)}`;
      case "syncing":
        return "Indexing now — this can take a minute";
      case "partial":
        return "Credentials saved, but nothing was indexed · check the key and access";
      case "error":
        return "Last sync failed · re-enter credentials to retry";
      default:
        return notConfiguredHint;
    }
  };

  const CONNECTIONS: Connection[] = [
    {
      id: "notion",
      name: "Notion",
      description: "Sync pages and databases from your Notion workspace.",
      status: stateFor("notion").status,
      meta: metaFor(
        "notion",
        stateFor("notion").oauth && !stateFor("notion").has_root
          ? "Notion authorized · pick a root page to finish setup"
          : stateFor("notion").workspace_name
            ? `Workspace · ${stateFor("notion").workspace_name}`
            : "Not set up · Connect with Notion (no token paste)",
      ),
      actionLabel:
        stateFor("notion").oauth && !stateFor("notion").has_root
          ? "Pick root page"
          : stateFor("notion").configured
            ? "Advanced"
            : "Advanced setup",
      oauthHref: "/api/auth/notion",
      oauthLabel:
        stateFor("notion").oauth || stateFor("notion").configured
          ? "Reconnect Notion"
          : "Connect Notion",
      syncable: Boolean(
        stateFor("notion").configured && (stateFor("notion").has_root ?? true),
      ),
      logo: <NotionLogo />,
    },
    {
      id: "gdocs",
      name: "Google Docs",
      description: "Index public Google Docs shared with your workspace.",
      status: stateFor("google_docs").status,
      meta: metaFor("google_docs", "Not set up · no auth required, just share the doc"),
      actionLabel: "Manage docs",
      syncable: stateFor("google_docs").configured,
      logo: <Image src="/icons/google-docs.png" alt="Google Docs" width={22} height={22} />,
    },
    {
      id: "tally",
      name: "Tally",
      description: "Pull form and survey responses so staff can ask about the feedback they've received.",
      status: stateFor("tally").status,
      meta: metaFor(
        "tally",
        stateFor("tally").oauth
          ? "Tally authorized · add form ids to finish setup"
          : "Not set up · Connect with Tally (no API key paste)",
      ),
      actionLabel: stateFor("tally").oauth && !stateFor("tally").has_forms
        ? "Add form ids"
        : stateFor("tally").configured
          ? "Advanced"
          : "Advanced setup",
      oauthHref: "/api/auth/tally",
      oauthLabel:
        stateFor("tally").oauth || stateFor("tally").configured
          ? "Reconnect Tally"
          : "Connect Tally",
      syncable: Boolean(
        stateFor("tally").configured && (stateFor("tally").has_forms ?? true),
      ),
      logo: <Image src="/icons/tally.svg" alt="Tally" width={22} height={22} />,
    },
    {
      id: "drive",
      name: "Google Drive",
      description: driveAllowed
        ? "Full Drive folder sync via service account connector."
        : "Pro and Plus — full Drive folder sync via service account connector.",
      status: driveAllowed ? stateFor("drive").status : "disconnected",
      // Drive's chunks are tagged "google_docs" by its loader, so indexed
      // volume isn't attributable to it — hence no chunk count here.
      meta: !driveAllowed
        ? "Upgrade on Billing to unlock Google Drive"
        : stateFor("drive").configured
          ? "Folder configured · shares indexed volume with Google Docs"
          : "Not set up · share a folder with the service account, then add its id",
      actionLabel: !driveAllowed
        ? "Upgrade"
        : stateFor("drive").configured
          ? "Change folder"
          : "Set up",
      actionHref: !driveAllowed ? "/admin/billing" : undefined,
      syncable: driveAllowed && stateFor("drive").configured,
      logo: <Image src="/icons/google-drive.svg" alt="Google Drive" width={22} height={22} />,
    },
    {
      id: "slack",
      name: "Slack",
      description: "Get Athena answers directly in Slack channels.",
      status: "soon",
      meta: "Planned · Q3 2025",
      actionLabel: "Notify me",
      syncable: false,
      logo: <Image src="/icons/slack_icon.svg" alt="Slack" width={32} height={32} />,
    },
    {
      id: "confluence",
      name: "Confluence",
      description: "Index Confluence spaces and pages as knowledge.",
      status: "soon",
      meta: "Planned · Q4 2025",
      actionLabel: "Notify me",
      syncable: false,
      logo: <Image src="/icons/atlassian_confluence.svg" alt="Confluence" width={22} height={22} />,
    },
  ];

  // Stable sort (native Array#sort since ES2019) — connectors keep their
  // relative order within a rank, only the groups themselves move.
  const orderedConnections = [...CONNECTIONS].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]
  );

  // The config modal now closes as soon as a sync job starts, instead of
  // waiting for it to finish — so nothing else refetches server data once the
  // job actually completes. Poll while any row is "syncing" so the row clears
  // itself back to "Connected" without a manual reload.
  const anySyncing = CONNECTIONS.some((c) => c.status === "syncing");
  useEffect(() => {
    if (!anySyncing) return;
    const id = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [anySyncing, router]);

  return (
    <>
      {/* Live summary — real backend data, replaces the old hardcoded meta */}
      <div
        style={{
          display: "flex",
          gap: 32,
          padding: "16px 24px",
          marginBottom: 20,
          background: "#fff",
          border: "1px solid #E8E8E8",
          borderRadius: 12,
          boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
        }}
      >
        {[
          { label: "Chunks indexed", value: stats ? stats.chunk_count.toLocaleString() : "—" },
          { label: "Sources", value: String(stats?.source_types?.length ?? 0) },
          { label: "Last synced", value: relativeTime(lastSynced) },
          {
            label: "Last run",
            value: latestJob
              ? latestJob.status === "running"
                ? "In progress"
                : latestJob.status === "failed"
                  ? "Failed"
                  : `${latestJob.chunks} chunks`
              : "No runs yet",
          },
        ].map((s) => (
          <div key={s.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 12, color: "#aaa" }}>{s.label}</span>
            <span style={{ fontSize: 18, color: "#111", fontWeight: 400, letterSpacing: "-0.01em" }}>{s.value}</span>
          </div>
        ))}
      </div>

      {latestJob?.status === "failed" &&
        latestJob.error &&
        dismissedJobErrorId !== latestJob.id && (
        <div
          className="notice notice-danger"
          style={{
            marginBottom: 20,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            justifyContent: "space-between",
          }}
          role="alert"
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
            }}
          >
            {userFacingError(latestJob.error, "The last sync failed. Try again.")}
          </span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setDismissedJobErrorId(latestJob.id)}
            style={{
              flexShrink: 0,
              border: "none",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              padding: "0 2px",
              opacity: 0.7,
            }}
          >
            ×
          </button>
        </div>
      )}

      {banner && (
        <div
          className="notice notice-info"
          style={{
            margin: "0 0 16px",
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            justifyContent: "space-between",
          }}
          role="status"
        >
          <span style={{ flex: 1, minWidth: 0 }}>{banner}</span>
          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={() => setBanner(null)}
            style={{
              flexShrink: 0,
              border: "none",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              padding: "0 2px",
              opacity: 0.7,
            }}
          >
            ×
          </button>
        </div>
      )}

<div
        style={{
          background: "#fff",
          border: "1px solid #E8E8E8",
          borderRadius: 12,
          boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
        }}
      >
        {orderedConnections.map((conn, i) => {
          const s = STATUS_CONFIG[conn.status];
          return (
            <div
              key={conn.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 20,
                padding: "20px 24px",
                borderBottom: i < orderedConnections.length - 1 ? "1px solid #F3F3F3" : "none",
                opacity: conn.status === "soon" ? 0.7 : 1,
              }}
            >
              {/* Logo badge */}
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 9,
                  background: "#F4F4F4",
                  border: "1px solid #E8E8E8",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
                  fontWeight: 400,
                  color: "#444",
                  flexShrink: 0,
                  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                }}
              >
                {conn.logo}
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
                  <span style={{ fontSize: 14, fontWeight: 400, color: "#111" }}>{conn.name}</span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 400,
                      color: s.text,
                      background: s.bg,
                      borderRadius: 20,
                      padding: "2px 8px",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: s.dot, display: "inline-block" }} />
                    {s.label}
                  </span>
                </div>
                <p style={{ fontSize: 13, color: "#888", margin: 0, lineHeight: 1.5 }}>{conn.description}</p>
                <p style={{ fontSize: 12, color: "#bbb", margin: "4px 0 0", fontFamily: "monospace" }}>{conn.meta}</p>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {conn.status === "syncing" ? (
                  // A job is running for this org. Configure/Sync are hidden rather
                  // than just disabled, so there's nothing to click while indexing
                  // is in flight — the row itself is the loading state.
                  <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "#1d4ed8" }}>
                    <span className="spinner" />
                    Syncing…
                  </span>
                ) : (
                  <>
                    {conn.syncable && <SyncButton />}
                    {conn.status === "soon" ? (
                      <NotifyButton
                        integration={conn.id}
                        initiallyNotified={notifiedIntegrations.includes(conn.id)}
                      />
                    ) : (
                      <>
                        {conn.oauthHref && (
                          <Button href={conn.oauthHref} variant="accent-solid" size="sm">
                            {conn.oauthLabel ?? "Connect"}
                          </Button>
                        )}
                        {conn.actionHref ? (
                          <Button href={conn.actionHref} variant="secondary" size="sm">
                            {conn.actionLabel}
                          </Button>
                        ) : CONNECTOR_FIELDS[conn.id] ? (
                          <ConfigureButton
                            label={conn.actionLabel}
                            destructive={conn.syncable}
                            tooltip={
                              conn.syncable
                                ? "Replaces the current setup and re-indexes"
                                : undefined
                            }
                            onClick={() => setConfiguring(conn.id)}
                          />
                        ) : null}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {configuring && (
        <ConnectorModal
          connectorId={configuring}
          configured={stateFor(configuring).configured}
          onClose={() => setConfiguring(null)}
        />
      )}
    </>
  );
}
