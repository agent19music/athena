"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { X } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import DocxPreview from "./DocxPreview";
import { Button } from "../Button";

const PdfPreview = dynamic(() => import("./PdfPreview"), { ssr: false });

type PreviewData =
  | { mode: "text"; title: string | null; content: string }
  | { mode: "markdown"; title: string | null; content: string }
  | { mode: "pdf"; title: string | null; signed_url: string; page_count: number }
  | { mode: "docx"; title: string | null; signed_url: string };

type Props = {
  docId: string;
  sourceType: string;
  excerpt?: string;
  onClose: () => void;
};

// Splits content around the first literal occurrence of excerpt so it can be
// wrapped in <mark>. excerpt is always a prefix of some chunk_text that the
// backend reassembles content from verbatim, so this reliably matches — see
// docs/specs/file-preview-spec.md.
function splitOnExcerpt(content: string, excerpt: string | undefined) {
  if (!excerpt) return { before: content, match: "", after: "" };
  const idx = content.indexOf(excerpt);
  if (idx === -1) return { before: content, match: "", after: "" };
  return {
    before: content.slice(0, idx),
    match: content.slice(idx, idx + excerpt.length),
    after: content.slice(idx + excerpt.length),
  };
}

// Shared by markdown/docx modes: neither can safely support an inline <mark>
// (react-markdown doesn't render raw HTML by default, and shouldn't for an
// org's own uploaded content; mammoth's sanitized HTML has no reliable
// text-node offset to wrap after conversion) — this gets the same "here's
// what was cited" value as a callout instead.
function ExcerptCallout({ excerpt, calloutRef }: { excerpt: string; calloutRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div
      ref={calloutRef}
      className="a-pv-callout"
      style={{
        background: "#FFFBEB",
        border: "1px solid #FEF3C7",
        borderRadius: 8,
        padding: "10px 12px",
        marginBottom: 16,
        fontSize: 13,
        color: "#78350F",
        lineHeight: 1.6,
      }}
    >
      {excerpt}
    </div>
  );
}

export default function PreviewPanel({ docId, sourceType, excerpt, onClose }: Props) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markRef = useRef<HTMLElement>(null);
  const calloutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ doc_id: docId, source_type: sourceType });
    fetch(`/api/documents/preview?${params}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? json.detail ?? "Couldn't load preview");
        return json as PreviewData;
      })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load preview"); });
    return () => { cancelled = true; };
  }, [docId, sourceType]);

  useEffect(() => {
    (markRef.current ?? calloutRef.current)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [data]);

  const parts = data?.mode === "text" ? splitOnExcerpt(data.content, excerpt) : null;

  return (
    <div
      className="a-pv-scrim"
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
        className="a-pv-sheet"
        style={{
          background: "#fff",
          borderRadius: 16,
          width: 640,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 64px)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="a-pv-head"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "20px 24px",
            borderBottom: "1px solid #F0F0F0",
            flexShrink: 0,
          }}
        >
          <h2
            className="a-pv-title"
            style={{
              fontSize: 15,
              fontWeight: 400,
              color: "#111",
              margin: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {data?.title ?? "Preview"}
          </h2>
          <Button type="button" onClick={onClose} variant="ghost" size="icon" className="a-pv-close" aria-label="Close preview" style={{ flexShrink: 0 }}>
            <X size={16} />
          </Button>
        </div>

        <div style={{ padding: "20px 24px", overflowY: "auto" }}>
          {error && (
            <p className="a-pv-err" style={{ fontSize: 13, color: "#B91C1C" }}>{error}</p>
          )}
          {!error && !data && (
            <div className="a-pv-muted" style={{ display: "flex", alignItems: "center", gap: 10, color: "#888", fontSize: 13 }}>
              <span className="spinner" />
              Loading preview…
            </div>
          )}
          {parts && (
            <p
              className="a-pv-text"
              style={{
                fontSize: 14,
                color: "#333",
                lineHeight: 1.7,
                whiteSpace: "pre-wrap",
                margin: 0,
              }}
            >
              {parts.before}
              {parts.match && (
                <mark
                  ref={markRef}
                  className="a-pv-mark"
                  style={{ background: "#FEF3C7", color: "#1a1a1a", borderRadius: 3, padding: "0 2px" }}
                >
                  {parts.match}
                </mark>
              )}
              {parts.after}
            </p>
          )}
          {data?.mode === "markdown" && (
            <>
              {excerpt && <ExcerptCallout excerpt={excerpt} calloutRef={calloutRef} />}
              <div className="a-pv-text" style={{ fontSize: 14, color: "#333", lineHeight: 1.7 }}>
                <ReactMarkdown>{data.content}</ReactMarkdown>
              </div>
            </>
          )}
          {data?.mode === "pdf" && (
            <PdfPreview signedUrl={data.signed_url} pageCount={data.page_count} excerpt={excerpt} />
          )}
          {data?.mode === "docx" && (
            <>
              {excerpt && <ExcerptCallout excerpt={excerpt} calloutRef={calloutRef} />}
              <DocxPreview signedUrl={data.signed_url} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
