"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { ArrowUpRight, FileText } from "@phosphor-icons/react";
import PreviewPanel from "./PreviewPanel";

export type SourceType = "google_docs" | "notion" | "tally" | "upload" | "mock";

interface DocumentCardProps {
  answer: string;
  sourceTitle?: string;
  sourceDocId?: string;
  sourceType?: SourceType;
  sourceExcerpt?: string;
  similarityScore?: number;
}

const SOURCE_LABELS: Record<string, string> = {
  google_docs: "Google Docs",
  notion: "Notion",
  tally: "Tally",
  upload: "Uploaded file",
  mock: "Internal",
};

// Sources with a real external URL we can link to directly.
const LINKABLE_SOURCE_TYPES: SourceType[] = ["google_docs", "notion"];

// Sources with an in-app preview (reassembled from stored chunk text — see
// docs/specs/file-preview-spec.md). Tally submissions have no per-response
// URL and no separate "file" to preview, so — like mock — they render nothing.
const PREVIEWABLE_SOURCE_TYPES: SourceType[] = ["upload"];

export default function DocumentCard({
  answer,
  sourceTitle,
  sourceDocId,
  sourceType,
  sourceExcerpt,
  similarityScore,
}: DocumentCardProps) {
  const [previewOpen, setPreviewOpen] = useState(false);

  const typeLabel = sourceType && sourceType !== "mock" ? SOURCE_LABELS[sourceType] ?? sourceType : null;
  const chipLabel = sourceTitle ? (typeLabel ? `${typeLabel} · ${sourceTitle}` : sourceTitle) : null;
  const linkable = !!sourceDocId && !!sourceType && LINKABLE_SOURCE_TYPES.includes(sourceType);
  const previewable = !!sourceDocId && !!sourceType && PREVIEWABLE_SOURCE_TYPES.includes(sourceType);

  return (
    <div className="a-ac a-ac-answer">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div className="a-ac-k" style={{ margin: 0 }}>Answer</div>
        {similarityScore !== undefined && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--a-muted)", letterSpacing: "0.02em" }}>
            {Math.round(similarityScore * 100)}% match
          </span>
        )}
      </div>

      <div className="a-ac-a ink">
        <ReactMarkdown
          components={{
            h1: ({ children }) => <p style={{ fontWeight: 500 }}>{children}</p>,
            h2: ({ children }) => <p style={{ fontWeight: 500 }}>{children}</p>,
            h3: ({ children }) => <p style={{ fontWeight: 500 }}>{children}</p>,
          }}
        >
          {answer}
        </ReactMarkdown>
      </div>

      {sourceExcerpt && (
        <div className="a-source-quote">
          <div className="a-ac-k" style={{ marginBottom: 4 }}>From the source</div>
          &ldquo;{sourceExcerpt.trim()}&rdquo;
        </div>
      )}

      {(chipLabel || linkable || previewable) && (
        <div className="a-ac-chips">
          {chipLabel && (
            <span className="a-chip" title={chipLabel}>
              <FileText size={12} />
              <span>{chipLabel}</span>
            </span>
          )}
          {linkable && (
            <a
              className="a-link-underline"
              style={{ marginLeft: "auto" }}
              href={
                sourceType === "notion"
                  ? `https://notion.so/${sourceDocId!.replace(/-/g, "")}`
                  : `https://docs.google.com/document/d/${sourceDocId}`
              }
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in {SOURCE_LABELS[sourceType!] ?? "source"}
              <ArrowUpRight size={12} />
            </a>
          )}
          {previewable && (
            <button type="button" className="a-link-underline" style={{ marginLeft: "auto" }} onClick={() => setPreviewOpen(true)}>
              Open in source
              <ArrowUpRight size={12} />
            </button>
          )}
        </div>
      )}

      {previewOpen && sourceDocId && sourceType && (
        <PreviewPanel
          docId={sourceDocId}
          sourceType={sourceType}
          excerpt={sourceExcerpt}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}
