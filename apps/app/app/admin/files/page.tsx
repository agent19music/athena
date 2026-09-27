"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { UploadSimple, Plus, FolderSimplePlus, CaretRight, CaretDown } from "@phosphor-icons/react";
import DashboardShell from "../../../components/DashboardShell";
import PageFadeIn from "../../../components/PageFadeIn";
import { Button } from "../../../components/Button";
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

const TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  PDF: { bg: "#FEF2F2", text: "#DC2626" },
  DOCX: { bg: "#EFF6FF", text: "#2563EB" },
  DOC: { bg: "#EFF6FF", text: "#2563EB" },
  MD: { bg: "#F0FDF4", text: "#16A34A" },
  TXT: { bg: "#F0FDF4", text: "#16A34A" },
  CSV: { bg: "#FFFBEB", text: "#D97706" },
  HTML: { bg: "#FDF4FF", text: "#9333EA" },
  NOTION: { bg: "#F4F4F4", text: "#555" },
};

function fileTypeFor(doc: BackendDocument): string {
  const name = doc.title || doc.doc_id;
  const ext = name.includes(".") ? name.split(".").pop()?.toUpperCase() : null;
  if (ext && ext.length <= 5) return ext;
  if (doc.source_type === "notion") return "NOTION";
  return "DOC";
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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
    <div style={{ background: "#FCFCFC", borderBottom: "1px solid #F0F0F0" }}>
      <div style={{ maxHeight: GROUP_MAX_HEIGHT, overflowY: "auto" }}>
        {rows.map(r => (
          <div
            key={r.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 72px 120px 100px",
              padding: "9px 20px 9px 44px",
              borderBottom: "1px solid #F6F6F6",
              alignItems: "center",
            }}
          >
            <p style={{ fontSize: 13, color: "#444", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.name}
            </p>
            <span style={{ fontSize: 11, color: "#bbb" }}>{r.chunks} chunks</span>
            <span style={{ fontSize: 12.5, color: "#999" }}>{r.uploaded}</span>
            <span />
          </div>
        ))}

        {error && (
          <p style={{ fontSize: 12.5, color: "#b91c1c", margin: 0, padding: "12px 20px 12px 44px" }}>{error}</p>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 20px 12px 44px" }}>
        <span style={{ fontSize: 12, color: "#aaa" }}>
          Showing {rows.length.toLocaleString()} of {total.toLocaleString()}
        </span>
        {rows.length < total && (
          <Button
            onClick={() => loadPage(rows.length)}
            disabled={loading}
            variant="secondary"
            size="sm"
          >
            {loading ? "Loading…" : `Load ${Math.min(GROUP_PAGE_SIZE, total - rows.length)} more`}
          </Button>
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

  return (
    <DashboardShell>
      <main style={{ flex: 1, overflowY: "auto", background: "#FAFAFA" }}>
        <PageFadeIn style={{ maxWidth: 880, margin: "0 auto", padding: "56px 48px 80px" }}>

          {/* Hidden File Input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.txt,.md,.html,.htm,.csv"
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) {
                uploadFiles(Array.from(e.target.files));
                e.target.value = "";
              }
            }}
          />

          {/* Hidden Folder Input */}
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error — webkitdirectory is not in React's types
            webkitdirectory=""
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) {
                uploadFiles(Array.from(e.target.files));
                e.target.value = "";
              }
            }}
          />

          {/* Header */}
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 40 }}>
            <div>
              <h1 style={{ fontSize: 32, fontWeight: 400, letterSpacing: "-0.025em", color: "#111", lineHeight: 1.2, margin: 0 }}>
                Files
              </h1>
              <p style={{ fontSize: 14, color: "#888", marginTop: 8 }}>
                {loading
                  ? "Loading…"
                  : `${totalDocuments.toLocaleString()} documents · ${totalChunks.toLocaleString()} chunks indexed`}
                {activeCount > 0 && ` · ${activeCount} uploading`}
              </p>
            </div>
          </div>

          {/* Drop zone / Click to upload */}
          <div
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files?.length) {
                uploadFiles(Array.from(e.dataTransfer.files));
              }
            }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragging ? "#1a1a1a" : "#DCDCDC"}`,
              borderRadius: 12,
              padding: "36px 24px",
              textAlign: "center",
              marginBottom: 32,
              background: dragging ? "#F4F4F4" : "#fff",
              transition: "border-color 150ms var(--ease-out), background 150ms var(--ease-out), transform 150ms var(--ease-out)",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
            }}
          >
            <>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: "50%",
                    background: "#F5F5F5",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#555",
                  }}
                >
                  <UploadSimple size={22} />
                </div>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 400, color: "#1a1a1a", margin: "0 0 4px" }}>
                    Drop files or a folder here, or pick them below
                  </p>
                  <p style={{ fontSize: 12, color: "#888", margin: 0 }}>
                    PDF, Word, Markdown, plain text, HTML, CSV — up to 25 MB per file
                  </p>
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                  <Button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                    variant="secondary"
                    full
                  >
                    <Plus size={14} /> Choose files
                  </Button>
                  <Button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      folderInputRef.current?.click();
                    }}
                    variant="secondary"
                    full
                  >
                    <FolderSimplePlus size={14} /> Choose folder
                  </Button>
                </div>
            </>
          </div>

          <UploadQueue items={queue} onRetry={retryItem} onDismiss={dismissItem} />

          {/* File table */}
          <div
            style={{
              background: "#fff",
              border: "1px solid #E8E8E8",
              borderRadius: 12,
              overflow: "hidden",
              boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
            }}
          >
            {/* Table header */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 72px 120px 100px",
                padding: "10px 20px",
                borderBottom: "1px solid #F0F0F0",
                background: "#FAFAFA",
              }}
            >
              {["Name", "Type", "Last indexed", "Source"].map(h => (
                <span key={h} style={{ fontSize: 11, color: "#aaa", letterSpacing: "0" }}>
                  {h}
                </span>
              ))}
            </div>

            {/* Rows */}
            {!loading && files.length === 0 ? (
              <div style={{ padding: "32px 20px", textAlign: "center" }}>
                <p style={{ fontSize: 13.5, color: "#999", margin: 0 }}>
                  No documents yet. Drop a file above or connect a source to get started.
                </p>
              </div>
            ) : (
              files.map((f, i) => {
                const isLast = i === files.length - 1;

                if (f.kind === "group") {
                  const isOpen = expanded.has(f.key);
                  return (
                    <div key={f.key}>
                      <div
                        role="button"
                        tabIndex={0}
                        aria-expanded={isOpen}
                        onClick={() => toggleGroup(f.key)}
                        onKeyDown={e => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggleGroup(f.key);
                          }
                        }}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 72px 120px 100px",
                          padding: "12px 20px",
                          borderBottom: isLast && !isOpen ? "none" : "1px solid #F6F6F6",
                          alignItems: "center",
                          cursor: "pointer",
                          transition: "background 100ms",
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#FAFAFA")}
                        onMouseLeave={e => (e.currentTarget.style.background = "")}
                      >
                        <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ color: "#bbb", display: "inline-flex", flexShrink: 0 }}>
                            {isOpen ? <CaretDown size={13} /> : <CaretRight size={13} />}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <p style={{ fontSize: 13.5, fontWeight: 400, color: "#222", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {f.label}
                            </p>
                            <p style={{ fontSize: 11, color: "#bbb", margin: "2px 0 0" }}>
                              {f.docCount.toLocaleString()} responses · {f.chunks.toLocaleString()} chunks
                            </p>
                          </div>
                        </div>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 400,
                            color: "#555",
                            background: "#F4F4F4",
                            borderRadius: 4,
                            padding: "3px 7px",
                            display: "inline-block",
                            letterSpacing: "-0.01em",
                            width: "fit-content",
                          }}
                        >
                          FORM
                        </span>
                        <span style={{ fontSize: 12.5, color: "#999" }}>{f.uploaded}</span>
                        <span style={{ fontSize: 12.5, color: "#bbb" }}>{f.source}</span>
                      </div>
                      {isOpen && <GroupChildren groupKey={f.key} />}
                    </div>
                  );
                }

                const tc = TYPE_COLORS[f.type] ?? { bg: "#F4F4F4", text: "#555" };
                return (
                  <div
                    key={f.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 72px 120px 100px",
                      padding: "12px 20px",
                      borderBottom: isLast ? "none" : "1px solid #F6F6F6",
                      alignItems: "center",
                      transition: "background 100ms",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#FAFAFA")}
                    onMouseLeave={e => (e.currentTarget.style.background = "")}
                  >
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 13.5, fontWeight: 400, color: "#222", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {f.name}
                      </p>
                      <p style={{ fontSize: 11, color: "#bbb", margin: 0, marginTop: 2 }}>
                        {f.chunks} chunks
                      </p>
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 400,
                        color: tc.text,
                        background: tc.bg,
                        borderRadius: 4,
                        padding: "3px 7px",
                        display: "inline-block",
                        letterSpacing: "-0.01em",
                        width: "fit-content",
                      }}
                    >
                      {f.type}
                    </span>
                    <span style={{ fontSize: 12.5, color: "#999" }}>{f.uploaded}</span>
                    <span style={{ fontSize: 12.5, color: "#bbb" }}>{f.source}</span>
                  </div>
                );
              })
            )}
          </div>

        </PageFadeIn>
      </main>
    </DashboardShell>
  );
}
