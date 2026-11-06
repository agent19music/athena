"use client";

import ConnectionsClient from "../../admin/connections/ConnectionsClient";
import type { ConnectorState } from "../../admin/connections/page";

const now = new Date(Date.now() - 1000 * 60 * 42).toISOString();

const connected: ConnectorState = {
  configured: true,
  status: "connected",
  chunk_count: 1284,
  last_synced: now,
  has_root: true,
  has_forms: true,
  oauth: true,
  workspace_name: "Athena",
};

export default function ConnectionsPreviewPage() {
  return (
    <main style={{ minHeight: "100svh", background: "#FAFAFA", overflowY: "auto" }}>
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "56px 48px 80px" }}>
        <ConnectionsClient
          stats={{
            chunk_count: 2400,
            last_synced: now,
            source_types: ["notion", "google_docs"],
            plan: "pro",
            limits: { drive: true },
          }}
          jobs={[]}
          notifiedIntegrations={[]}
          connectors={{
            notion: connected,
            google_docs: { ...connected, oauth: false, has_root: false, chunk_count: 86 },
            tally: {
              configured: false,
              status: "disconnected",
              chunk_count: 0,
              last_synced: null,
              has_forms: false,
              has_root: false,
              oauth: false,
            },
            drive: { ...connected, oauth: false, chunk_count: 0 },
          }}
        />
      </div>
    </main>
  );
}
