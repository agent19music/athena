"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowsClockwise, CheckCircle, WarningCircle, X } from "@phosphor-icons/react";

export type QueueStatus = "queued" | "uploading" | "done" | "chunk_failed" | "upload_failed";

export type QueueItem = {
  id: string;
  file: File;
  name: string;
  status: QueueStatus;
  reason?: string;
  attempts: number;
};

function statusLabel(item: QueueItem): string {
  switch (item.status) {
    case "queued":
      return "Waiting";
    case "uploading":
      return item.attempts > 1 ? "Reuploading and indexing" : "Uploading and indexing";
    case "done":
      return "Indexed";
    case "chunk_failed":
      return item.reason ?? "Couldn't index this file. Check that it isn't password protected, then retry.";
    case "upload_failed":
      return item.reason ?? "Couldn't reach the server";
  }
}

function StatusIcon({ status }: { status: QueueStatus }) {
  if (status === "done") return <CheckCircle size={16} weight="fill" color="var(--a-olive)" />;
  if (status === "chunk_failed" || status === "upload_failed") return <WarningCircle size={16} weight="fill" color="var(--a-danger)" />;
  return <ArrowsClockwise size={16} color="var(--a-muted)" className={status === "uploading" ? "a-spin" : undefined} />;
}

/** Per-file upload status card (Files frame): progress, indexed, or failed with Retry. */
export default function UploadQueue({
  items,
  onRetry,
  onDismiss,
}: {
  items: QueueItem[];
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const reduce = useReducedMotion();
  if (items.length === 0) return null;

  return (
    <div className="a-card a-clip" style={{ marginBottom: 32 }} aria-live="polite">
      <AnimatePresence initial={false}>
        {items.map((item, i) => {
          const failed = item.status === "chunk_failed" || item.status === "upload_failed";
          const busy = item.status === "uploading" || item.status === "queued";
          return (
            <motion.div
              key={item.id}
              initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, height: "auto" }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
              style={{ overflow: "hidden", borderTop: i === 0 ? undefined : "1px solid var(--a-line)" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
                <StatusIcon status={item.status} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="a-ellipsis" style={{ fontSize: 14 }} title={item.name}>{item.name}</div>
                  <div style={{ fontSize: 12, color: failed ? "var(--a-danger)" : "var(--a-muted)" }}>{statusLabel(item)}</div>
                  {busy && (
                    <div className="a-bar thin a-bar-indeterminate" style={{ marginTop: 8 }}>
                      <span />
                    </div>
                  )}
                </div>
                {failed && (
                  <>
                    <button type="button" className="a-btn a-btn-secondary a-btn-sm" onClick={() => onRetry(item.id)}>
                      Retry
                    </button>
                    <button type="button" className="a-icon-btn sm bare" aria-label="Dismiss" onClick={() => onDismiss(item.id)}>
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
