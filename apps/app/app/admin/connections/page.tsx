import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import DashboardShell, { AppPage } from "../../../components/DashboardShell";
import { PageHeader } from "../../../components/athena/ui";
import ConnectionsClient, { SyncButton } from "./ConnectionsClient";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";

type OrgStats = {
  chunk_count: number;
  last_synced: string | null;
  source_types: string[];
  plan?: string;
  limits?: { drive?: boolean; source_types?: number | null };
};
type Job = {
  id: string;
  status: string;
  trigger: string;
  documents: number;
  chunks: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
};
export type ConnectorState = {
  configured: boolean;
  status: "connected" | "partial" | "disconnected" | "syncing" | "error";
  chunk_count: number;
  last_synced: string | null;
  has_forms?: boolean;
  has_root?: boolean;
  oauth?: boolean;
  workspace_name?: string;
};

export default async function ConnectionsPage() {
  const { userId, orgId, orgRole, getToken } = await auth();

  if (!userId) redirect("/login");
  if (!orgId) redirect("/onboarding");
  if (orgRole !== "org:admin") redirect("/dashboard");

  let stats: OrgStats | null = null;
  let jobs: Job[] = [];
  let notifiedIntegrations: string[] = [];
  let connectors: Record<string, ConnectorState> = {};
  try {
    const token = await getToken();
    if (token) {
      const headers = { Authorization: `Bearer ${token}` };
      const [statsRes, statusRes, notifyRes, connRes] = await Promise.all([
        fetch(`${BACKEND_URL}/stats`, { headers, cache: "no-store" }),
        fetch(`${BACKEND_URL}/ingest/status`, { headers, cache: "no-store" }),
        fetch(`${BACKEND_URL}/integrations/notify`, { headers, cache: "no-store" }),
        fetch(`${BACKEND_URL}/connections`, { headers, cache: "no-store" }),
      ]);
      if (statsRes.ok) stats = await statsRes.json();
      if (statusRes.ok) jobs = (await statusRes.json()).jobs ?? [];
      if (notifyRes.ok) notifiedIntegrations = (await notifyRes.json()).integrations ?? [];
      if (connRes.ok) connectors = (await connRes.json()).connectors ?? {};

      const entRes = await fetch(`${BACKEND_URL}/billing/entitlement`, {
        headers,
        cache: "no-store",
      });
      if (entRes.ok) {
        const ent = await entRes.json();
        const paid = ent.is_paid === true || ent.source === "paddle" || ent.source === "promo";
        if (!paid) redirect("/admin/billing?welcome=1");
      }
    }
  } catch {
    /* backend unreachable — client renders with empty state */
  }

  return (
    <DashboardShell>
      <AppPage>
        <PageHeader
          title="Connections"
          sub="Manage knowledge sources. Connected services are re-indexed each time you sync."
          hideActionsOnMobile
          actions={(stats?.source_types?.length ?? 0) > 0 ? <SyncButton label="Sync all sources" variant="primary" size="md" /> : undefined}
        />
        <ConnectionsClient
          stats={stats}
          jobs={jobs}
          notifiedIntegrations={notifiedIntegrations}
          connectors={connectors}
        />
      </AppPage>
    </DashboardShell>
  );
}
