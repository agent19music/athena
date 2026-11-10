"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Flat confirmation overlay from the Doop frames (Delete conversation,
 * Cancel subscription, Sign out): 360px card, danger icon tile, two buttons.
 */
export function ConfirmDialog({
  open,
  icon,
  title,
  body,
  cancelLabel = "Keep it",
  confirmLabel,
  confirmIcon,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  icon: ReactNode;
  title: ReactNode;
  body: ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  confirmIcon?: ReactNode;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="a-scrim a-root" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="a-dialog" role="alertdialog" aria-modal="true" aria-labelledby="a-dialog-title">
        <span className="a-dialog-icon">{icon}</span>
        <h2 id="a-dialog-title">{title}</h2>
        <p>{body}</p>
        <div className="a-dialog-actions">
          <button ref={cancelRef} type="button" className="a-btn a-btn-secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className="a-btn a-btn-danger" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {confirmIcon}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
