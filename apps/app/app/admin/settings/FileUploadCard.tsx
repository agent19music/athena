"use client";

import { useAuth } from "@clerk/nextjs";
import { useRef, useState } from "react";
import { FileArrowUp, FolderSimplePlus } from "@phosphor-icons/react";
import { Button } from "@/components/Button";
import { uploadFailureReason, uploadToBackend } from "@/lib/uploadToBackend";
import { userFacingError } from "@/lib/userFacingError";

type UploadResult = {
  uploaded: number;
  chunks: number;
  skipped: { name: string; reason: string }[];
};

export default function FileUploadCard() {
  const { getToken } = useAuth();
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setState("uploading");
    setResult(null);

    const form = new FormData();
    for (const file of Array.from(files)) {
      // Use webkitRelativePath as the filename when uploading folders
      // so the backend can use the folder structure in metadata
      const name = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      form.append("files", file, name);
    }

    try {
      const bytes = Array.from(files).reduce((n, file) => n + file.size, 0);
      const token = await getToken();
      const res = await uploadToBackend(form, token, bytes);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setErrorMsg(uploadFailureReason(res.status, data));
        setState("error");
      } else {
        setResult(data);
        setState("done");
      }
    } catch (err) {
      setErrorMsg(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Could not reach server");
      setState("error");
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    upload(e.dataTransfer.files);
  }

  const isUploading = state === "uploading";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          border: `1px dashed ${dragging ? "#1a1a1a" : "#d4d4d4"}`,
          borderRadius: 8,
          padding: "40px 24px",
          textAlign: "center",
          background: dragging ? "#f9f9f9" : "#ffffff",
          transition: "border-color 150ms, background 150ms",
          cursor: isUploading ? "not-allowed" : "default",
        }}
      >
        {isUploading ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 16 }}>
            <span className="spinner" />
            <span style={{ fontSize: 14, color: "#6b6b6b" }}>Uploading and indexing…</span>
          </div>
        ) : (
          <p style={{ fontSize: 14, color: "#6b6b6b", margin: "0 0 16px 0", lineHeight: 1.55 }}>
            Drop files or a folder here, or pick them below
          </p>
        )}
        <p style={{ fontSize: 12, color: "#a3a3a3", margin: "0 0 20px 0" }}>
          .txt · .md · .pdf · .docx · .html · .csv — up to 25 MB per file
        </p>

        <div style={{ display: "flex", justifyContent: "center", gap: 10 }}>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".txt,.md,.pdf,.docx,.html,.htm,.csv"
            style={{ display: "none" }}
            onChange={(e) => upload(e.target.files)}
            disabled={isUploading}
          />
          <Button
            onClick={() => fileRef.current?.click()}
            disabled={isUploading}
            variant="secondary"
            full
          >
            <FileArrowUp size={14} /> Choose files
          </Button>

          <input
            ref={folderRef}
            type="file"
            // @ts-expect-error — webkitdirectory is not in React's types
            webkitdirectory=""
            multiple
            style={{ display: "none" }}
            onChange={(e) => upload(e.target.files)}
            disabled={isUploading}
          />
          <Button
            onClick={() => folderRef.current?.click()}
            disabled={isUploading}
            variant="secondary"
            full
          >
            <FolderSimplePlus size={14} /> Choose folder
          </Button>
        </div>
      </div>

      {state === "done" && result && (
        <div style={{ fontSize: 13, color: "#6b6b6b" }}>
          <p style={{ margin: "0 0 4px 0", color: "#3a7a5a" }}>
            ✓ {result.uploaded} file{result.uploaded !== 1 ? "s" : ""} indexed
            {" "}· {result.chunks} chunks added
          </p>
          {result.skipped.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer", color: "#a3a3a3" }}>
                {result.skipped.length} skipped
              </summary>
              <ul style={{ margin: "6px 0 0 0", paddingLeft: 16 }}>
                {result.skipped.map((s, i) => (
                  <li key={i} style={{ marginBottom: 2 }}>
                    <code style={{ fontSize: 11 }}>{s.name}</code>
                    {" — "}{userFacingError(s.reason, "Skipped")}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {state === "error" && (
        <p style={{ fontSize: 13, color: "#e05a5a", margin: 0 }}>{errorMsg}</p>
      )}
    </div>
  );
}
