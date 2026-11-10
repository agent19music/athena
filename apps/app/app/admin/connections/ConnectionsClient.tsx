"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowsClockwise, Bell, Check, DotsThree, WarningCircle, X } from "@phosphor-icons/react";
import { Badge, type BadgeTone } from "@/components/athena/ui";
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

// eslint-disable-next-line @next/next/no-img-element
const Logo = ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} style={{ width: 20, height: 20, objectFit: "contain", display: "block" }} />;

const STATUS_CONFIG: Record<Status, { label: string; tone: BadgeTone }> = {
  connected: { label: "Connected", tone: "ok" },
  syncing: { label: "Syncing", tone: "warn" },
  // "Partial" now means only one thing: credentials are stored but the run
  // indexed nothing (bad key, empty form, revoked access). A connector with no
  // credentials is "Not connected".
  partial: { label: "Nothing indexed", tone: "warn" },
  error: { label: "Last sync failed", tone: "err" },
  disconnected: { label: "Not connected", tone: "neutral" },
  soon: { label: "Coming soon", tone: "neutral" },
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

// Hits the real /api/admin/sync route, waits for the run, then refreshes
// server data so the status/chunk-count reflect the new run.
function useSync(body?: Record<string, unknown>) {
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
  return { state, sync };
}

export function SyncButton({
  body,
  label = "Sync now",
  variant = "secondary",
  size = "sm",
}: {
  body?: Record<string, unknown>;
  label?: string;
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
}) {
  const { state, sync } = useSync(body);
  const text = state === "syncing" ? "Syncing…" : state === "done" ? "Done" : state === "error" ? "Retry" : label;
  return (
    <button
      type="button"
      onClick={sync}
      disabled={state === "syncing"}
      className={`a-btn ${state === "error" ? "a-btn-danger-quiet" : `a-btn-${variant}`}${size === "sm" ? " a-btn-sm" : ""}`}
      title="Trigger a manual sync now"
    >
      {state === "done" ? <Check size={14} /> : <ArrowsClockwise size={14} className={state === "syncing" ? "a-spin" : undefined} />}
      {text}
    </button>
  );
}

type MenuItem = { label: string; href?: string; onClick?: () => void; hint?: string };

// "More actions" popover on a source row.
function MoreMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="a-icon-btn sm" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <DotsThree size={16} />
      </button>
      {open && (
        <div className="a-menu" role="menu">
          {items.map((it) =>
            it.href ? (
              <a key={it.label} role="menuitem" href={it.href} onClick={() => setOpen(false)}>
                <span>{it.label}</span>
                {it.hint && <small>{it.hint}</small>}
              </a>
            ) : (
              <button key={it.label} type="button" role="menuitem" onClick={() => { setOpen(false); it.onClick?.(); }}>
                <span>{it.label}</span>
                {it.hint && <small>{it.hint}</small>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
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
    <div className="a-scrim a-root" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={spec.title} className="a-dialog" style={{ width: 480, padding: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px", borderBottom: "1px solid var(--a-line)" }}>
          <h2 style={{ fontSize: 18, fontWeight: 400, margin: 0 }}>{spec.title}</h2>
          <button type="button" className="a-icon-btn sm bare" aria-label="Close" onClick={onClose}>
            <X size={16} color="var(--a-ink)" />
          </button>
        </div>

        <div style={{ padding: "20px 24px 24px" }}>
          <p style={{ fontSize: 14, color: "var(--a-muted)", lineHeight: 1.55, margin: "0 0 20px" }}>
            {spec.blurb}
            {spec.docs && (
              <>
                {" "}
                <a href={spec.docs} target="_blank" rel="noreferrer" style={{ color: "var(--a-ink)", borderBottom: "1px solid var(--a-line2)" }}>
                  Where do I find this?
                </a>
              </>
            )}
          </p>

          {configured && (
            <div className="a-notice" style={{ marginBottom: 20 }}>
              <WarningCircle size={14} weight="fill" />
              <span>Already connected. Saving replaces the stored credentials and re-indexes.</span>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {connectorId === "notion" && notionPages.length > 0 && (
              <div className="a-field">
                <label className="a-label" htmlFor="notion_page_picker">Pages shared with Athena</label>
                <div className="a-input">
                  <select
                    id="notion_page_picker"
                    value={values.notion_root_page_id ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, notion_root_page_id: e.target.value }))}
                  >
                    <option value="">Select a root page…</option>
                    {notionPages.map((page) => (
                      <option key={page.id} value={page.id}>{page.title}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            {spec.fields.map((f) => (
              <div key={f.key} className="a-field">
                <label className="a-label" htmlFor={f.key}>{f.label}</label>
                <div className="a-input">
                  <input
                    id={f.key}
                    type={f.secret ? "password" : "text"}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    autoComplete="off"
                  />
                </div>
                <span style={{ fontSize: 12, color: "var(--a-muted)", lineHeight: 1.5 }}>{f.hint}</span>
              </div>
            ))}
          </div>

          {error && <p style={{ fontSize: 13, color: "var(--a-danger)", margin: "16px 0 0", lineHeight: 1.5 }}>{error}</p>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}>
            <button type="button" className="a-btn a-btn-secondary" onClick={onClose}>
              {state === "syncing" ? "Close and keep syncing" : "Cancel"}
            </button>
            <button type="button" className="a-btn a-btn-primary" onClick={save} disabled={!ready || busy}>
              {state === "saving" ? "Saving…" : state === "syncing" ? "Indexing…" : "Save and sync"}
            </button>
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
    state === "loading" ? "Saving…" : state === "done" ? "Noted" : state === "error" ? "Retry" : "Notify me";

  return (
    <button
      type="button"
      onClick={notify}
      disabled={state === "loading" || state === "done"}
      className={`a-btn a-btn-sm ${state === "error" ? "a-btn-danger-quiet" : "a-btn-secondary"}`}
    >
      {state === "done" ? <Check size={14} /> : <Bell size={14} />}
      {label}
    </button>
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
      meta: stateFor("notion").status === "connected" && stateFor("notion").workspace_name
        ? `Workspace · ${stateFor("notion").workspace_name}`
        : metaFor(
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
      logo: <Logo src="/icons/notion.svg" alt="Notion" />,
    },
    {
      id: "gdocs",
      name: "Google Docs",
      description: "Index Google Docs shared with your workspace.",
      status: stateFor("google_docs").status,
      meta: metaFor("google_docs", "Not set up · no auth required, just share the doc"),
      actionLabel: "Manage docs",
      syncable: stateFor("google_docs").configured,
      logo: <Logo src="/icons/google-docs.png" alt="Google Docs" />,
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
      logo: <Logo src="/icons/tally.svg" alt="Tally" />,
    },
    {
      id: "drive",
      name: "Google Drive",
      description: driveAllowed
        ? "Full Drive folder sync through a service account connector."
        : "Pro and Advanced: full Drive folder sync through a service account connector.",
      status: driveAllowed ? stateFor("drive").status : "disconnected",
      // Drive's chunks are tagged "google_docs" by its loader, so indexed
      // volume isn't attributable to it — hence no chunk count here.
      meta: !driveAllowed
        ? "Upgrade on Billing to unlock Google Drive"
        : stateFor("drive").configured
          ? "Folder configured · shares indexed volume with Google Docs"
          : "Share a folder with the service account, then add its id",
      actionLabel: !driveAllowed
        ? "Upgrade"
        : stateFor("drive").configured
          ? "Change folder"
          : "Set up",
      actionHref: !driveAllowed ? "/admin/billing" : undefined,
      syncable: driveAllowed && stateFor("drive").configured,
      logo: <Logo src="/icons/google-drive.svg" alt="Google Drive" />,
    },
    {
      id: "slack",
      name: "Slack",
      description: "Get Athena answers directly in Slack channels.",
      status: "soon",
      meta: "Planned",
      actionLabel: "Notify me",
      syncable: false,
      logo: <Logo src="/icons/slack_icon.svg" alt="Slack" />,
    },
    {
      id: "confluence",
      name: "Confluence",
      description: "Index Confluence spaces and pages as knowledge.",
      status: "soon",
      meta: "Planned",
      actionLabel: "Notify me",
      syncable: false,
      logo: <Logo src="/icons/atlassian_confluence.svg" alt="Confluence" />,
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

  const planName = stats?.plan ? stats.plan.charAt(0).toUpperCase() + stats.plan.slice(1) : null;
  const sourceLimit = stats?.limits?.source_types;
  const usedSources = stats?.source_types?.length ?? 0;

  const summary = [
    { label: "Chunks indexed", value: stats ? stats.chunk_count.toLocaleString() : "—" },
    { label: "Sources", value: String(usedSources) },
    { label: "Last synced", value: lastSynced ? relativeTime(lastSynced) : "Never" },
    {
      label: "Last run",
      value: latestJob
        ? latestJob.status === "running"
          ? "In progress"
          : latestJob.status === "failed"
            ? "Failed"
            : "Completed"
        : "No runs yet",
    },
  ];

  function actionsFor(conn: Connection) {
    if (conn.status === "syncing") {
      // A job is running for this org. Configure/Sync are hidden rather than
      // just disabled, so there's nothing to click while indexing is in flight.
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--a-muted)" }}>
          <ArrowsClockwise size={14} className="a-spin" />
          Syncing…
        </span>
      );
    }
    if (conn.status === "soon") {
      return <NotifyButton integration={conn.id} initiallyNotified={notifiedIntegrations.includes(conn.id)} />;
    }
    if (conn.actionHref) {
      return (
        <Link href={conn.actionHref} className="a-btn a-btn-secondary a-btn-sm">
          {conn.actionLabel}
        </Link>
      );
    }

    const canConfigure = !!CONNECTOR_FIELDS[conn.id];
    const configure = () => setConfiguring(conn.id);
    const menu: MenuItem[] = [];

    if (conn.syncable) {
      if (conn.oauthHref) menu.push({ label: conn.oauthLabel ?? "Reconnect", href: conn.oauthHref });
      if (canConfigure && conn.id !== "gdocs") menu.push({ label: conn.actionLabel, hint: "Replaces the current setup and re-indexes", onClick: configure });
      return (
        <>
          {conn.id === "gdocs" && canConfigure ? (
            <button type="button" className="a-btn a-btn-secondary a-btn-sm" onClick={configure}>{conn.actionLabel}</button>
          ) : (
            <SyncButton />
          )}
          <MoreMenu items={conn.id === "gdocs" ? [{ label: "Sync now", onClick: () => syncAll() }] : menu} />
        </>
      );
    }

    // Not yet syncable: lead with the one action that finishes setup.
    const needsPick = conn.actionLabel === "Pick root page" || conn.actionLabel === "Add form ids";
    if (conn.oauthHref && !needsPick) {
      if (canConfigure) menu.push({ label: conn.actionLabel, onClick: configure });
      return (
        <>
          <a href={conn.oauthHref} className="a-btn a-btn-primary a-btn-sm">{conn.oauthLabel ?? "Connect"}</a>
          <MoreMenu items={menu} />
        </>
      );
    }
    if (canConfigure) {
      return (
        <button type="button" className="a-btn a-btn-primary a-btn-sm" onClick={configure}>
          {conn.id === "drive" && conn.actionLabel === "Set up" ? "Set up Drive" : conn.actionLabel}
        </button>
      );
    }
    return null;
  }

  async function syncAll() {
    try {
      await fetch("/api/admin/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } finally {
      router.refresh();
    }
  }

  return (
    <>
      <div className="a-card a-clip a-statstrip mb" style={{ marginBottom: 32 }}>
        {summary.map((s) => (
          <div key={s.label}>
            <div className="l">{s.label}</div>
            <div className="v a-serif">{s.value}</div>
          </div>
        ))}
      </div>

      {latestJob?.status === "failed" && latestJob.error && dismissedJobErrorId !== latestJob.id && (
        <div className="a-notice err" style={{ marginBottom: 16 }} role="alert">
          <WarningCircle size={14} weight="fill" />
          <span style={{ flex: 1, minWidth: 0 }}>{userFacingError(latestJob.error, "The last sync failed. Try again.")}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setDismissedJobErrorId(latestJob.id)} style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", display: "flex", padding: 2 }}>
            <X size={14} />
          </button>
        </div>
      )}

      {banner && (
        <div className="a-notice ok" style={{ marginBottom: 16 }} role="status">
          <Check size={14} />
          <span style={{ flex: 1, minWidth: 0 }}>{banner}</span>
          <button type="button" aria-label="Dismiss notice" onClick={() => setBanner(null)} style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", display: "flex", padding: 2 }}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="a-sec-t">
        <h2>Sources</h2>
        {typeof sourceLimit === "number" && planName && (
          <span className="a-only-d" style={{ fontSize: 13, color: "var(--a-muted)" }}>
            {usedSources} of {sourceLimit} data sources used on {planName}
          </span>
        )}
      </div>

      <div className="a-card a-clip a-divide">
        {orderedConnections.map((conn) => {
          const s = STATUS_CONFIG[conn.status];
          return (
            <div key={conn.id} className="a-src-row">
              <span className="a-tile lg">{conn.logo}</span>
              <div className="a-src-info">
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15 }}>{conn.name}</span>
                  <span className="a-only-d"><Badge tone={s.tone}>{s.label}</Badge></span>
                </div>
                <div className="a-src-desc">{conn.description}</div>
                <div className="a-src-meta">{conn.meta}</div>
              </div>
              <span className="a-only-m a-src-badge"><Badge tone={s.tone}>{s.label}</Badge></span>
              <div className="a-src-actions">{actionsFor(conn)}</div>
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
