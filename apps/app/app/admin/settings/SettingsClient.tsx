"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowRight, Camera, PencilSimple, UploadSimple } from "@phosphor-icons/react";
import { OrgLogo } from "../../../components/athena/Orb";
import { ThemeControl } from "../../../components/athena/ThemeControl";

function Row({ title, desc, wide, children }: { title: string; desc: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className="a-set-row">
      <div className={wide ? "k wide" : "k"}>
        <div className="t">{title}</div>
        <div className="d">{desc}</div>
      </div>
      <div className="v">{children}</div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div className="a-kicker" style={{ marginBottom: 10 }}>{label}</div>
      <div className="a-card a-clip a-divide a-set-card">{children}</div>
    </>
  );
}

function LogoUpload({ initialLogo, seed }: { initialLogo: string | null; seed: string }) {
  const [logo, setLogo] = useState(initialLogo);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setUploading(true);
    setError("");
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/orgs/logo", { method: "PATCH", body: form });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "Upload failed");
      else setLogo(data.imageUrl);
    } catch {
      setError("Could not reach server");
    }
    setUploading(false);
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) upload(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <span style={{ display: "flex", borderRadius: 12, overflow: "hidden", border: "1px solid var(--a-line)", width: 48, height: 48, flexShrink: 0 }}>
        <OrgLogo src={logo} seed={seed} size={48} />
      </span>
      <button type="button" className="a-btn a-btn-secondary a-btn-sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
        <Camera size={14} />
        {uploading ? "Uploading…" : logo ? "Replace logo" : "Upload logo"}
      </button>
      {error && <p style={{ fontSize: 13, color: "var(--a-danger)", width: "100%", textAlign: "inherit" }}>{error}</p>}
    </>
  );
}

function InlineNameEdit({ initialName }: { initialName: string }) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(initialName);
  const [draft, setDraft] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(displayName);
    setError("");
    setEditing(true);
    // focus after render
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function cancel() {
    setEditing(false);
    setError("");
  }

  async function save() {
    if (!draft.trim() || draft.trim() === displayName) {
      cancel();
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/orgs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draft.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Could not save");
        setSaving(false);
        return;
      }
      setDisplayName(draft.trim());
      setEditing(false);
    } catch {
      setError("Could not reach server");
    }
    setSaving(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") save();
    if (e.key === "Escape") cancel();
  }

  if (editing) {
    return (
      <>
        <div className="a-input" style={{ width: 260, maxWidth: "100%" }}>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={saving}
            aria-label="Organisation name"
          />
        </div>
        <button type="button" className="a-btn a-btn-primary a-btn-sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="a-btn a-btn-ghost a-btn-sm" onClick={cancel} disabled={saving}>
          Cancel
        </button>
        {error && <p style={{ fontSize: 13, color: "var(--a-danger)", width: "100%" }}>{error}</p>}
      </>
    );
  }

  return (
    <>
      <span style={{ fontSize: 14 }}>{displayName}</span>
      <button type="button" className="a-icon-btn sm" onClick={startEdit} aria-label="Edit name">
        <PencilSimple size={14} />
      </button>
    </>
  );
}

export default function SettingsClient({
  isAdmin,
  orgName,
  orgLogo,
  orgId,
}: {
  isAdmin: boolean;
  orgName: string;
  orgLogo: string | null;
  orgId?: string;
}) {
  const appearance = (
    <Section label="Appearance">
      <Row
        wide
        title="Theme"
        desc="System default follows this device and updates if the device theme changes. Light or Dark stays until you change it."
      >
        <ThemeControl />
      </Row>
    </Section>
  );

  if (!isAdmin) return appearance;

  return (
    <>
      {appearance}

      <Section label="Organisation">
        <Row title="Name" desc="Shown to everyone in your workspace.">
          <InlineNameEdit initialName={orgName} />
        </Row>
        <Row title="Logo" desc="PNG or SVG, square works best.">
          <LogoUpload initialLogo={orgLogo} seed={orgId ?? orgName} />
        </Row>
      </Section>

      <Section label="Connections">
        <Row title="Data sources" desc="Manage your Notion, Google Docs and Drive integrations, and run a manual sync.">
          <Link href="/admin/connections" className="a-btn a-btn-secondary a-btn-sm">
            Manage connections
            <ArrowRight size={12} />
          </Link>
        </Row>
      </Section>

      <Section label="Upload files">
        <Row title="Documents" desc="PDF, Word, Markdown, plain text, HTML and CSV.">
          <Link href="/admin/files" className="a-btn a-btn-secondary a-btn-sm">
            <UploadSimple size={14} />
            Upload files
          </Link>
        </Row>
      </Section>
    </>
  );
}
