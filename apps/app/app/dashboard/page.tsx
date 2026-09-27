import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import DashboardShell from "../../components/DashboardShell";
import PageFadeIn from "../../components/PageFadeIn";
import { userFacingError } from "../../lib/userFacingError";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";
const BACKEND_API_SECRET = process.env.BACKEND_API_SECRET ?? "";

type OrgStats = {
  chunk_count: number;
  last_synced: string | null;
  source_types: string[];
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

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function jobToActivity(j: Job) {
  const time = relativeTime(j.finished_at ?? j.started_at);
  if (j.status === "failed") {
    return {
      label: "Sync failed",
      sub: userFacingError(j.error, "Sync failed. Try again."),
      time,
      dot: "#ef4444",
    };
  }
  if (j.status === "running") {
    return { label: "Sync in progress", sub: "Indexing sources", time, dot: "#60a5fa" };
  }
  const src = `${j.documents} doc${j.documents === 1 ? "" : "s"} · ${j.chunks.toLocaleString()} chunks`;
  return { label: "Knowledge sync completed", sub: src, time, dot: "#22c55e" };
}

export default async function DashboardPage() {
  const { userId, orgId, orgRole, getToken } = await auth();

  if (!userId) redirect("/login");
  if (!orgId) redirect("/onboarding");

  const isAdmin = orgRole === "org:admin";

  // Fetch Clerk org data — wrap so a Clerk API error (wrong keys, deleted org)
  // never crashes the page; fall back to what auth() already gave us.
  let memberCount = 1;
  try {
    const client = await clerkClient();
    const memberships = await client.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      limit: 100,
    });
    memberCount = memberships.totalCount ?? memberships.data.length;
  } catch { /* use fallback */ }

  // Use server-to-server auth for backend reads — avoids the JWT org_id issue
  // where getToken() can return a token without org_id when the Clerk session
  // doesn't have an active org embedded in the JWT claims.
  let stats: OrgStats | null = null;
  let jobs: Job[] = [];
  if (BACKEND_API_SECRET) {
    try {
      const headers = {
        "X-API-Key": BACKEND_API_SECRET,
        "X-Org-Id": orgId,
      };
      const [statsRes, statusRes] = await Promise.all([
        fetch(`${BACKEND_URL}/stats`, { headers, cache: "no-store" }),
        fetch(`${BACKEND_URL}/ingest/status`, { headers, cache: "no-store" }),
      ]);
      if (statsRes.ok) stats = await statsRes.json();
      if (statusRes.ok) jobs = (await statusRes.json()).jobs ?? [];
    } catch { /* stats/jobs stay empty */ }
  }

  const activity = jobs.map(jobToActivity);

  const lastSynced = stats?.last_synced
    ? new Date(stats.last_synced).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "Never";

  const sourceCount = stats?.source_types?.length ?? 0;

  return (
    <DashboardShell>
      <style>{`
        .dashboard-wrap { padding: 56px 48px 80px; }
        .stat-grid { grid-template-columns: repeat(4, 1fr); }
        .dashboard-lower { grid-template-columns: 1fr 320px; gap: 32px; }

        @media (max-width: 768px) {
          .dashboard-wrap { padding: 24px 16px 64px; }
          .stat-grid { grid-template-columns: repeat(2, 1fr); }
          .dashboard-lower { grid-template-columns: 1fr; gap: 24px; }
        }
      `}</style>
      <main style={{ flex: 1, overflowY: "auto", background: "#FAFAFA" }}>
        <PageFadeIn className="dashboard-wrap" style={{ maxWidth: 880, margin: "0 auto" }}>

          {/* Page heading */}
          <div style={{ marginBottom: 40 }}>
            <h1 style={{ fontSize: 32, fontWeight: 400, letterSpacing: "-0.025em", color: "#111", lineHeight: 1.1, margin: 0 }}>
              Overview
            </h1>
          </div>

          {/* Stat row */}
          <div
            className="stat-grid"
            style={{
              display: "grid",
              gap: 1,
              background: "#E8E8E8",
              border: "1px solid #E8E8E8",
              borderRadius: 10,
              overflow: "hidden",
              marginBottom: 40,
              boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
            }}
          >
            {[
              { label: "Chunks indexed", value: stats ? stats.chunk_count.toLocaleString() : "—", sub: `Last synced ${lastSynced}` },
              { label: "Team members", value: String(memberCount), sub: isAdmin ? "You are admin" : "Member access" },
              { label: "Sources connected", value: String(sourceCount), sub: sourceCount > 0 ? (stats?.source_types ?? []).join(", ") : "No sources yet" },
              { label: "Status", value: "Active", sub: "All systems operational" },
            ].map((s, i) => (
              <div
                key={s.label}
                style={{
                  background: "#fff",
                  padding: "20px 22px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <p style={{ fontSize: 12, fontWeight: 400, color: "#aaa", margin: 0, letterSpacing: "-0.01em" }}>
                  {s.label}
                </p>
                <p style={{ fontSize: 28, fontWeight: 400, letterSpacing: "-0.03em", color: "#111", margin: 0, lineHeight: 1.15, fontVariantNumeric: "tabular-nums" }}>
                  {s.value}
                </p>
                <p style={{ fontSize: 12, color: "#bbb", margin: 0, lineHeight: 1.4 }}>{s.sub}</p>
              </div>
            ))}
          </div>

          {/* Two-column lower section */}
          <div className="dashboard-lower" style={{ display: "grid", alignItems: "start" }}>

            {/* Recent activity */}
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <h2 style={{ fontSize: 13, fontWeight: 400, color: "#111", margin: 0, letterSpacing: "-0.01em" }}>
                  Recent activity
                </h2>
                {isAdmin && (
                  <Link href="/admin/connections" style={{ fontSize: 12, color: "#888", textDecoration: "none" }}>
                    View connections →
                  </Link>
                )}
              </div>
              <div
                style={{
                  background: "#fff",
                  border: "1px solid #E8E8E8",
                  borderRadius: 10,
                  overflow: "hidden",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
                }}
              >
                {activity.length === 0 ? (
                  <div style={{ padding: "20px", fontSize: 13, color: "#999", lineHeight: 1.5 }}>
                    No ingestion runs yet. Connect a source and sync to see activity here.
                  </div>
                ) : activity.map((a, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 14,
                      padding: "14px 20px",
                      borderBottom: i < activity.length - 1 ? "1px solid #F3F3F3" : "none",
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: a.dot,
                        flexShrink: 0,
                        boxShadow: `0 0 0 3px ${a.dot}22`,
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 13.5, fontWeight: 400, color: "#222", margin: 0, lineHeight: 1.35 }}>
                        {a.label}
                      </p>
                      <p
                        style={{
                          fontSize: 12,
                          color: "#999",
                          margin: 0,
                          marginTop: 1,
                          overflow: "hidden",
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                        }}
                      >
                        {a.sub}
                      </p>
                    </div>
                    <span style={{ fontSize: 12, color: "#bbb", flexShrink: 0 }}>{a.time}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Quick actions */}
            <div>
              <h2 style={{ fontSize: 13, fontWeight: 400, color: "#111", marginBottom: 16, letterSpacing: "-0.01em" }}>
                Quick actions
              </h2>
              <div
                style={{
                  background: "#fff",
                  border: "1px solid #E8E8E8",
                  borderRadius: 10,
                  overflow: "hidden",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
                }}
              >
                {[
                  { href: "/chat", label: "Ask a question", sub: "Search your knowledge base" },
                  ...(isAdmin
                    ? [
                        { href: "/admin/connections", label: "Manage connections", sub: "Notion, Google Docs, Drive" },
                        { href: "/admin/files", label: "Upload files", sub: "PDF, Word, Markdown, CSV" },
                        { href: "/admin/staff", label: "Invite team member", sub: `${memberCount} members` },
                      ]
                    : []),
                ].map((action, i, arr) => (
                  <Link
                    key={action.href}
                    href={action.href}
                    className="dashboard-action-link"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      padding: "14px 18px",
                      textDecoration: "none",
                      borderBottom: i < arr.length - 1 ? "1px solid #F3F3F3" : "none",
                    }}
                  >
                    <span style={{ fontSize: 13.5, fontWeight: 400, color: "#222" }}>{action.label}</span>
                    <span style={{ fontSize: 12, color: "#aaa" }}>{action.sub}</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>

        </PageFadeIn>
      </main>
    </DashboardShell>
  );
}
