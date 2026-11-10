"use client";

import { useAuth } from "@clerk/nextjs";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretRight, FileText, FolderSimplePlus, MagnifyingGlass, Plugs, Plus, UploadSimple } from "@phosphor-icons/react";
import DashboardShell, { AppPage } from "../../../components/DashboardShell";
import { BtnLink, PageHeader, SectionTitle, Tag, Tile } from "../../../components/athena/ui";
import UploadQueue, { type QueueItem } from "./UploadQueue";
import { uploadFailureReason, uploadToBackend } from "../../../lib/uploadToBackend";
import { userFacingError } from "../../../lib/userFacingError";

const UPLOAD_CONCURRENCY = 3;
const SETTLE_MS = 1400;
const REFRESH_DEBOUNCE_MS = 350;

function fileDisplayName(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

type DocFile = {
  id: string;
  name: string;
  type: string;
  chunks: number;
  uploaded: string;
  source: string;
};

// A row is either one document or a collapsed Tally form standing in for many.
// The backend decides which (see GROUP_THRESHOLD) so a form with thousands of
// responses never reaches the browser as thousands of rows.
type GroupRow = {
  kind: "group";
  key: string;
  label: string;
  docCount: number;
  chunks: number;
  uploaded: string;
  source: string;
};
type DocRow = DocFile & { kind: "document" };
type Row = DocRow | GroupRow;

// `kind` is a literal on both variants (the backend always sets it) so the
// union discriminates without a cast.
type BackendDocument = {
  kind: "document";
  doc_id: string;
  title: string | null;
  source_type: string | null;
  chunks: number;
  last_indexed: string | null;
};

type BackendGroup = {
  kind: "group";
  group_key: string;
  label: string;
  source_type: string | null;
  doc_count: number;
  chunks: number;
  last_indexed: string | null;
};

type BackendEntry = BackendDocument | BackendGroup;

const SOURCE_LABELS: Record<string, string> = {
  upload: "Upload",
  notion: "Notion",
  google_docs: "Google Docs",
  tally: "Tally",
  mock: "Sample",
};

function fileTypeFor(doc: BackendDocument): string {
  const name = doc.title || doc.doc_id;
  const ext = name.includes(".") ? name.split(".").pop()?.toUpperCase() : null;
  if (ext && ext.length <= 5) return ext;
  if (doc.source_type === "notion") return "NOTION";
  if (doc.source_type === "google_docs") return "GDOC";
  if (doc.source_type === "tally") return "FORM";
  return "DOC";
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function mapDocuments(docs: BackendDocument[]): DocRow[] {
  return docs.map(d => ({
    kind: "document" as const,
    id: d.doc_id,
    name: d.title || d.doc_id,
    type: fileTypeFor(d),
    chunks: d.chunks,
    uploaded: formatDate(d.last_indexed),
    source: SOURCE_LABELS[d.source_type ?? ""] ?? d.source_type ?? "Unknown",
  }));
}

function mapEntries(entries: BackendEntry[]): Row[] {
  return entries.map(e =>
    e.kind === "group"
      ? {
          kind: "group" as const,
          key: e.group_key,
          label: e.label,
          docCount: e.doc_count,
          chunks: e.chunks,
          uploaded: formatDate(e.last_indexed),
          source: SOURCE_LABELS[e.source_type ?? ""] ?? e.source_type ?? "Unknown",
        }
      : mapDocuments([e])[0]
  );
}

const GROUP_PAGE_SIZE = 50;
const GROUP_MAX_HEIGHT = 320;

// The responses inside one collapsed form. Loaded on first expand and paged
// from there, so opening a 10k-response form costs one 50-row request.
function GroupChildren({ groupKey }: { groupKey: string }) {
  const [rows, setRows] = useState<DocRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadPage = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/files?group=${encodeURIComponent(groupKey)}&limit=${GROUP_PAGE_SIZE}&offset=${offset}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error("Could not load responses");
      const data = await res.json();
      setTotal(data.total ?? 0);
      setRows(prev => (offset === 0 ? mapDocuments(data.documents ?? []) : [...prev, ...mapDocuments(data.documents ?? [])]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load responses");
    } finally {
      setLoading(false);
    }
  }, [groupKey]);

  useEffect(() => {
    loadPage(0);
  }, [loadPage]);

  return (
    <div style={{ background: "var(--a-bg)", borderTop: "1px solid var(--a-line)" }}>
      <div style={{ maxHeight: GROUP_MAX_HEIGHT, overflowY: "auto" }}>
        {rows.map(r => (
          <div key={r.id} className="a-group-child">
            <span className="a-ellipsis" style={{ fontSize: 13 }}>{r.name}</span>
            <span style={{ fontSize: 12, color: "var(--a-muted)", flexShrink: 0 }}>{r.chunks} chunks · {r.uploaded}</span>
          </div>
        ))}
        {error && <p style={{ fontSize: 13, color: "var(--a-danger)", padding: "12px 20px 12px 44px" }}>{error}</p>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 20px 12px 44px" }}>
        <span style={{ fontSize: 12, color: "var(--a-muted)" }}>
          Showing {rows.length.toLocaleString()} of {total.toLocaleString()}
        </span>
        {rows.length < total && (
          <button type="button" className="a-btn a-btn-secondary a-btn-sm" onClick={() => loadPage(rows.length)} disabled={loading}>
            {loading ? "Loading…" : `Load ${Math.min(GROUP_PAGE_SIZE, total - rows.length)} more`}
          </button>
        )}
      </div>
    </div>
  );
}

export default function FilesPage() {
  const { getToken } = useAuth();
  const [files, setFiles] = useState<Row[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [paid, setPaid] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("All");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/billing/entitlement", { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setPaid(true); // fail open for read; upload still backend-gated
          return;
        }
        const ent = await res.json();
        const isPaid = ent.is_paid === true || ent.source === "paddle" || ent.source === "promo";
        if (!cancelled) setPaid(isPaid);
        if (!isPaid) {
          window.location.replace("/admin/billing?welcome=1");
        }
      } catch {
        if (!cancelled) setPaid(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadFiles = useCallback(async () => {
    try {
      const res = await fetch("/api/files", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setFiles([]);
        return;
      }
      setFiles(mapEntries(data.entries ?? []));
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  const totalChunks = files.reduce((n, f) => n + f.chunks, 0);
  // A group row stands for many documents, so count its members rather than the
  // row itself — otherwise a 1,200-response form reads as a single document.
  const totalDocuments = files.reduce((n, f) => n + (f.kind === "group" ? f.docCount : 1), 0);
  const activeCount = queue.filter((q) => q.status === "queued" || q.status === "uploading").length;

  const toggleGroup = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => loadFiles(), REFRESH_DEBOUNCE_MS);
  }, [loadFiles]);

  const scheduleRemoval = useCallback((id: string) => {
    setTimeout(() => {
      setQueue((prev) => prev.filter((q) => q.id !== id));
    }, SETTLE_MS);
  }, []);

  // Each file is its own request so one bad file never blocks the rest of the
  // batch, and status (upload vs. indexing failure) is knowable per file.
  const processItem = useCallback(async (item: QueueItem) => {
    updateItem(item.id, { status: "uploading", reason: undefined, attempts: item.attempts + 1 });

    const formData = new FormData();
    formData.append("files", item.file, item.name);

    let res: Response;
    try {
      const token = await getToken();
      res = await uploadToBackend(formData, token, item.file.size);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Couldn't reach the server";
      updateItem(item.id, {
        status: "upload_failed",
        reason: reason === "Failed to fetch" ? "Couldn't reach the server" : reason,
      });
      return;
    }

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      updateItem(item.id, { status: "chunk_failed", reason: uploadFailureReason(res.status, data) });
      return;
    }

    const skipped = (data?.skipped ?? []).find((s: { name: string }) => s.name === item.name);
    if (skipped) {
      updateItem(item.id, {
        status: "chunk_failed",
        reason: userFacingError(skipped.reason, "Couldn't index this file."),
      });
      return;
    }

    updateItem(item.id, { status: "done" });
    scheduleRefresh();
    scheduleRemoval(item.id);
  }, [getToken, updateItem, scheduleRefresh, scheduleRemoval]);

  const runQueue = useCallback((items: QueueItem[]) => {
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const item = items[next++];
        await processItem(item);
      }
    }
    const workers = Math.min(UPLOAD_CONCURRENCY, items.length);
    for (let i = 0; i < workers; i++) worker();
  }, [processItem]);

  const uploadFiles = useCallback((filesToUpload: File[]) => {
    if (paid === false) {
      window.location.replace("/admin/billing?welcome=1");
      return;
    }
    if (!filesToUpload.length) return;
    const newItems: QueueItem[] = filesToUpload.map((file) => ({
      id: crypto.randomUUID(),
      file,
      name: fileDisplayName(file),
      status: "queued",
      attempts: 0,
    }));
    setQueue((prev) => [...prev, ...newItems]);
    runQueue(newItems);
  }, [runQueue, paid]);

  const retryItem = useCallback((id: string) => {
    const item = queueRef.current.find((q) => q.id === id);
    if (item) processItem(item);
  }, [processItem]);

  const dismissItem = useCallback((id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  }, []);

  const sources = useMemo(() => Array.from(new Set(files.map((f) => f.source))).sort(), [files]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter((f) => {
      if (sourceFilter !== "All" && f.source !== sourceFilter) return false;
      if (!q) return true;
      const name = f.kind === "group" ? f.label : f.name;
      return name.toLowerCase().includes(q);
    });
  }, [files, query, sourceFilter]);

  const summary = loading
    ? "Loading…"
    : `${totalDocuments.toLocaleString()} document${totalDocuments === 1 ? "" : "s"} · ${totalChunks.toLocaleString()} chunks indexed${activeCount > 0 ? ` · ${activeCount} uploading` : ""}`;

  function rowMeta(f: Row) {
    return f.kind === "group"
      ? `${f.docCount.toLocaleString()} responses · ${f.chunks.toLocaleString()} chunks`
      : `${f.chunks.toLocaleString()} chunks`;
  }

  return (
    <DashboardShell>
      <AppPage>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.doc,.docx,.txt,.md,.html,.htm,.csv"
          hidden
          onChange={(e) => {
            if (e.target.files?.length) {
              uploadFiles(Array.from(e.target.files));
              e.target.value = "";
            }
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          // @ts-expect-error — webkitdirectory is not in React's types
          webkitdirectory=""
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) {
              uploadFiles(Array.from(e.target.files));
              e.target.value = "";
            }
          }}
        />

        <PageHeader
          title="Files"
          sub={summary}
          hideActionsOnMobile
          actions={
            <>
              <BtnLink href="/admin/connections" variant="secondary">
                <Plugs size={14} />
                Connect a source
              </BtnLink>
              <button type="button" className="a-btn a-btn-primary" onClick={() => fileInputRef.current?.click()}>
                <UploadSimple size={14} />
                Upload files
              </button>
            </>
          }
        />

        <div
          className={`a-drop${dragging ? " over" : ""}`}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files?.length) uploadFiles(Array.from(e.dataTransfer.files));
          }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
        >
          <Tile><UploadSimple size={16} /></Tile>
          <div>
            <div style={{ fontSize: 14 }}>Drop files or a folder here, or choose them below</div>
            <div style={{ fontSize: 12, color: "var(--a-muted)", marginTop: 4 }}>
              PDF, Word, Markdown, plain text, HTML and CSV, up to 25 MB per file
            </div>
          </div>
          <div className="a-drop-actions">
            <button type="button" className="a-btn a-btn-secondary" onClick={() => fileInputRef.current?.click()}>
              <Plus size={14} />
              Choose files
            </button>
            <button type="button" className="a-btn a-btn-secondary" onClick={() => folderInputRef.current?.click()}>
              <FolderSimplePlus size={14} />
              Choose folder
            </button>
          </div>
        </div>

        <UploadQueue items={queue} onRetry={retryItem} onDismiss={dismissItem} />
        {queue.length === 0 && <div style={{ height: 16 }} />}

        <SectionTitle
          aside={
            <div className="a-only-d" style={{ display: "flex", gap: 8 }}>
              <label className="a-input pill a-search">
                <MagnifyingGlass size={14} color="var(--a-faint)" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search documents" aria-label="Search documents" />
              </label>
              <label className="a-btn a-btn-secondary" style={{ position: "relative" }}>
                Source · {sourceFilter}
                <CaretDown size={12} />
                <select
                  aria-label="Filter by source"
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
                >
                  <option value="All">All</option>
                  {sources.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </div>
          }
        >
          Indexed documents
        </SectionTitle>
        <label className="a-input pill a-search a-only-m">
          <MagnifyingGlass size={14} color="var(--a-faint)" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search documents" aria-label="Search documents" />
        </label>

        <div className="a-card a-clip">
          {!loading && visible.length === 0 ? (
            <div style={{ padding: "40px 24px", textAlign: "center", color: "var(--a-muted)", fontSize: 14 }}>
              {files.length === 0 ? "No documents indexed yet. Upload files or connect a source to get started." : "No documents match your search."}
            </div>
          ) : (
            <>
              <table className="a-tbl a-only-d">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th style={{ width: 120 }}>Type</th>
                    <th style={{ width: 180 }}>Last indexed</th>
                    <th style={{ width: 160 }}>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr><td colSpan={4} className="muted">Loading…</td></tr>
                  )}
                  {visible.map((f) => {
                    if (f.kind === "group") {
                      const open = expanded.has(f.key);
                      return (
                        <Fragment key={f.key}>
                          <tr className="click" onClick={() => toggleGroup(f.key)} aria-expanded={open}>
                            <td>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                {open ? <CaretDown size={14} color="var(--a-muted)" /> : <CaretRight size={14} color="var(--a-muted)" />}
                                <div style={{ minWidth: 0 }}>
                                  <div className="a-ellipsis">{f.label}</div>
                                  <div style={{ fontSize: 12, color: "var(--a-muted)" }}>{rowMeta(f)}</div>
                                </div>
                              </div>
                            </td>
                            <td><Tag>FORM</Tag></td>
                            <td className="muted">{f.uploaded}</td>
                            <td className="muted">{f.source}</td>
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={4} style={{ padding: 0, height: "auto" }}>
                                <GroupChildren groupKey={f.key} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    }
                    return (
                      <tr key={f.id}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <FileText size={16} color="var(--a-muted)" style={{ flexShrink: 0 }} />
                            <div style={{ minWidth: 0 }}>
                              <div className="a-ellipsis" title={f.name}>{f.name}</div>
                              <div style={{ fontSize: 12, color: "var(--a-muted)" }}>{rowMeta(f)}</div>
                            </div>
                          </div>
                        </td>
                        <td><Tag>{f.type}</Tag></td>
                        <td className="muted">{f.uploaded}</td>
                        <td className="muted">{f.source}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="a-only-m a-files-list a-divide">
                {loading && <div className="item" style={{ color: "var(--a-muted)" }}>Loading…</div>}
                {visible.map((f) => {
                  const isGroup = f.kind === "group";
                  const key = isGroup ? f.key : f.id;
                  const open = isGroup && expanded.has(f.key);
                  return (
                    <div key={key}>
                      <div
                        className="item"
                        onClick={isGroup ? () => toggleGroup(f.key) : undefined}
                        style={isGroup ? { cursor: "pointer" } : undefined}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="a-ellipsis" style={{ fontSize: 14 }}>{isGroup ? f.label : f.name}</div>
                          <div className="a-ellipsis" style={{ fontSize: 12, color: "var(--a-muted)" }}>
                            {f.source} · {f.uploaded} · {rowMeta(f)}
                          </div>
                        </div>
                        <Tag>{isGroup ? "FORM" : f.type}</Tag>
                      </div>
                      {open && <GroupChildren groupKey={f.key} />}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </AppPage>
    </DashboardShell>
  );
}
