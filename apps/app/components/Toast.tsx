"use client";

import { useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CheckCircle, WarningCircle, X } from "@phosphor-icons/react";

type ToastProps = {
  message: string | null;
  onDismiss: () => void;
  duration?: number;
  /** "success" shows a check, "warn" a warning mark. Defaults to warn for backwards compatibility. */
  tone?: "success" | "warn";
};

/** Flat ink toast from the canon map: pill, icon, no shadow. */
export function Toast({ message, onDismiss, duration = 7000, tone = "warn" }: ToastProps) {
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!message) return;
    const id = setTimeout(onDismiss, duration);
    return () => clearTimeout(id);
  }, [message, duration, onDismiss]);

  return (
    <AnimatePresence>
      {message && (
        <motion.div
          className="a-toast a-root"
          initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)" }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px)" }}
          transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
          role="status"
        >
          {tone === "success" ? <CheckCircle size={16} weight="fill" style={{ flexShrink: 0 }} /> : <WarningCircle size={16} weight="fill" style={{ flexShrink: 0 }} />}
          <span style={{ flex: 1 }}>{message}</span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            style={{ flexShrink: 0, display: "flex", background: "transparent", border: "none", padding: 4, cursor: "pointer", color: "rgba(255,255,255,0.6)", borderRadius: 999 }}
          >
            <X size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
