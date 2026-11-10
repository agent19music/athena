"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { ArrowRight } from "@phosphor-icons/react";

/** Overview hero "Ask Athena" card: sends the question to /chat?q=… */
const MQ = "(max-width: 767px)";
function subscribe(cb: () => void) {
  const m = window.matchMedia(MQ);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
export function useIsMobile() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(MQ).matches, () => false);
}

export function AskCard({ placeholder, placeholderMobile }: { placeholder: string; placeholderMobile: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const mobile = useIsMobile();
  return (
    <div className="a-ac">
      <div className="a-ac-k">Ask Athena</div>
      <div className="a-ac-q" style={{ marginBottom: 12 }}>Answers come from your connected docs, with the source attached.</div>
      <form
        className="a-input pill"
        style={{ height: 44, padding: "0 6px 0 18px" }}
        onSubmit={(e) => {
          e.preventDefault();
          const v = q.trim();
          router.push(v ? `/chat?q=${encodeURIComponent(v)}` : "/chat");
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={mobile ? placeholderMobile : placeholder}
          aria-label="Ask Athena"
        />
        <button type="submit" className="a-btn a-btn-primary a-btn-sm" style={{ height: 32 }}>
          Ask
          <ArrowRight size={14} />
        </button>
      </form>
    </div>
  );
}
