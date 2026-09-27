"use client";

import { useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "@phosphor-icons/react";

type ToastProps = {
  message: string | null;
  onDismiss: () => void;
  duration?: number;
  tone?: "default" | "success";
};

export function Toast({ message, onDismiss, duration = 7000, tone = "default" }: ToastProps) {
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
          initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px) scale(0.98)" }}
          animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px) scale(0.98)" }}
          transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 100,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            maxWidth: 360,
            background: tone === "success" ? "#15803d" : "#131316",
            color: "#ffffff",
            fontSize: 14,
            lineHeight: 1.5,
            fontWeight: 400,
            borderRadius: 10,
            padding: "14px 14px 14px 16px",
            boxShadow:
              tone === "success"
                ? "0 8px 24px rgba(21, 128, 61, 0.28)"
                : "0 8px 24px rgba(0,0,0,0.24)",
          }}
          role="status"
        >
          <span style={{ flex: 1 }}>{message}</span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            style={{
              flexShrink: 0,
              display: "flex",
              background: "transparent",
              border: "none",
              padding: 2,
              cursor: "pointer",
              color: "rgba(255,255,255,0.6)",
            }}
          >
            <X size={16} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
