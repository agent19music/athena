"use client";

import { useEffect, useState } from "react";

type Props = { signedUrl: string };

export default function DocxPreview({ signedUrl }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [{ default: mammoth }, { default: DOMPurify }] = await Promise.all([
          import("mammoth"),
          import("dompurify"),
        ]);
        const res = await fetch(signedUrl);
        const arrayBuffer = await res.arrayBuffer();
        const { value } = await mammoth.convertToHtml({ arrayBuffer });
        // mammoth only ever emits structural HTML derived from the docx's own
        // paragraphs/runs/tables — docx has no mechanism to smuggle a <script>
        // through that conversion. Sanitizing anyway as defense-in-depth
        // before a dangerouslySetInnerHTML of user-uploaded content.
        const clean = DOMPurify.sanitize(value);
        if (!cancelled) setHtml(clean);
      } catch {
        if (!cancelled) setError("Couldn't render this document.");
      }
    })();

    return () => { cancelled = true; };
  }, [signedUrl]);

  if (error) return <p className="a-pv-err" style={{ fontSize: 13, color: "#B91C1C" }}>{error}</p>;

  if (!html) {
    return (
      <div className="a-pv-muted" style={{ display: "flex", alignItems: "center", gap: 10, color: "#888", fontSize: 13, padding: "40px 0" }}>
        <span className="spinner" />
        Loading document…
      </div>
    );
  }

  return (
    <div
      className="docx-preview-body a-pv-text"
      style={{ fontSize: 14, color: "#333", lineHeight: 1.7 }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
