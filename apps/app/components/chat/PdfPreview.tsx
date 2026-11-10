"use client";

import { useEffect, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type Props = {
  signedUrl: string;
  pageCount: number;
  excerpt?: string;
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// Best-effort: pdfplumber (server-side extraction) and pdf.js (client-side
// rendering) tokenize a page's text differently — there's no shared offset
// system to rely on. This looks for a text run that's a substring of the
// excerpt, or whose start overlaps the excerpt's start, which is reliable
// enough for "which page, roughly where" without claiming pixel precision.
function isLikelyMatch(itemText: string, excerpt: string): boolean {
  const item = norm(itemText);
  if (item.length < 4) return false;
  const ex = norm(excerpt);
  return ex.includes(item) || item.includes(ex.slice(0, 40));
}

export default function PdfPreview({ signedUrl, pageCount, excerpt }: Props) {
  const [pageNumber, setPageNumber] = useState(1);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (!excerpt) { setSearched(true); return; }
    let cancelled = false;

    (async () => {
      const doc = await pdfjs.getDocument(signedUrl).promise;
      for (let n = 1; n <= pageCount; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        const pageText = content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
        if (norm(pageText).includes(norm(excerpt).slice(0, 60))) {
          if (!cancelled) setPageNumber(n);
          break;
        }
      }
      if (!cancelled) setSearched(true);
    })();

    return () => { cancelled = true; };
  }, [signedUrl, pageCount, excerpt]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <Document file={signedUrl} loading={<PdfLoading />}>
        <Page
          pageNumber={pageNumber}
          width={560}
          customTextRenderer={excerpt ? ({ str }) => (
            isLikelyMatch(str, excerpt)
              ? `<mark style="background:#FEF3C7;color:#1a1a1a;border-radius:3px;">${str}</mark>`
              : str
          ) : undefined}
        />
      </Document>
      <p className="a-pv-muted" style={{ fontSize: 12, color: "#999", margin: 0 }}>
        Page {pageNumber} of {pageCount}
        {!searched && " · locating the cited passage…"}
      </p>
    </div>
  );
}

function PdfLoading() {
  return (
    <div className="a-pv-muted" style={{ display: "flex", alignItems: "center", gap: 10, color: "#888", fontSize: 13, padding: "40px 0" }}>
      <span className="spinner" />
      Loading document…
    </div>
  );
}
