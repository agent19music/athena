/** Display names and logos for knowledge-source types returned by the backend. */
export type SourceKey = "notion" | "google_docs" | "google_drive" | "tally" | "upload" | "slack" | "confluence";

const SOURCES: Record<string, { label: string; logo: string | null }> = {
  notion: { label: "Notion", logo: "/icons/notion.svg" },
  google_docs: { label: "Google Docs", logo: "/icons/google-docs.png" },
  google_drive: { label: "Google Drive", logo: "/icons/google-drive.svg" },
  drive: { label: "Google Drive", logo: "/icons/google-drive.svg" },
  tally: { label: "Tally", logo: "/icons/tally.svg" },
  slack: { label: "Slack", logo: "/icons/slack_icon.svg" },
  confluence: { label: "Confluence", logo: "/icons/atlassian_confluence.svg" },
  upload: { label: "Uploaded files", logo: null },
  uploads: { label: "Uploaded files", logo: null },
};

export function sourceLabel(key: string | null | undefined): string {
  if (!key) return "Source";
  return SOURCES[key]?.label ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function sourceLogo(key: string | null | undefined): string | null {
  if (!key) return null;
  return SOURCES[key]?.logo ?? null;
}
