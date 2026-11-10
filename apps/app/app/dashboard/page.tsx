import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  ArrowsClockwise,
  CaretRight,
  ChatTeardropText,
  CheckCircle,
  FileText,
  Plugs,
  UploadSimple,
  Users,
} from "@phosphor-icons/react/dist/ssr";
import DashboardShell, { AppPage } from "../../components/DashboardShell";
import { BtnLink, PageHeader, SectionTitle, StatCard, Tile } from "../../components/athena/ui";
import { AskCard } from "../../components/athena/AskCard";
import { Greeting } from "../../components/athena/Greeting";
import { sourceLabel } from "../../components/athena/sources";
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
      tone: "err" as const,
    };
  }
  if (j.status === "running") {
    return { label: "Sync in progress", sub: "Indexing sources", time, tone: "run" as const };
  }
  const src = `${j.documents} doc${j.documents === 1 ? "" : "s"} · ${j.chunks.toLocaleString()} chunks`;
  return { label: "Knowledge sync completed", sub: src, time, tone: "ok" as const };
}

export default async function DashboardPage() {
  const { userId, orgId, orgRole, getToken } = await auth();

  if (!userId) redirect("/login");
  if (!orgId) redirect("/onboarding");

  const isAdmin = orgRole === "org:admin";

  let firstName: string | null = null;
  let orgName: string | null = null;
  try {
    const u = await currentUser();
    firstName = u?.firstName ?? null;
  } catch { /* greeting falls back to no name */ }

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
    orgName = memberships.data[0]?.organization?.name ?? null;
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

  const activity = jobs.slice(0, 6).map(jobToActivity);

  const lastSynced = stats?.last_synced
    ? new Date(stats.last_synced).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "Never";

  const sourceTypes = stats?.source_types ?? [];
  const sourceCount = sourceTypes.length;

  const actions = [
    { href: "/chat", label: "Ask a question", sub: "Search your knowledge base", icon: <ChatTeardropText size={16} /> },
    ...(isAdmin
      ? [
          { href: "/admin/connections", label: "Manage connections", sub: "Notion, Google Docs, Drive", icon: <Plugs size={16} /> },
          { href: "/admin/files", label: "Upload files", sub: "PDF, Word, Markdown, CSV", icon: <UploadSimple size={16} /> },
          { href: "/admin/staff", label: "Invite team member", sub: `${memberCount} member${memberCount === 1 ? "" : "s"}`, icon: <Users size={16} /> },
        ]
      : []),
  ];

  return (
    <DashboardShell>
      <AppPage>
        <PageHeader
          title="Overview"
          sub={<><Greeting name={firstName} /> Here is what Athena has indexed for {orgName ?? "your organisation"}.</>}
          subMobile="Here is what Athena has indexed for your organisation."
          hideActionsOnMobile
          actions={
            <>
              {isAdmin && (
                <BtnLink href="/admin/connections" variant="secondary">
                  <ArrowsClockwise size={14} />
                  Sync now
                </BtnLink>
              )}
              <BtnLink href="/chat" variant="primary">
                <ChatTeardropText size={14} />
                New chat
              </BtnLink>
            </>
          }
        />

        <div className="a-hero">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/dither-colosseum-olive.webp" alt="" />
          <AskCard placeholder="Ask anything about how we work" placeholderMobile="Ask about how we work" />
        </div>

        <div className="a-stats" style={{ marginBottom: 40 }}>
          <StatCard
            icon={<FileText size={16} />}
            value={stats ? stats.chunk_count.toLocaleString() : "—"}
            label="Chunks indexed"
            hint={`Last synced ${lastSynced}`}
          />
          <StatCard
            icon={<Users size={16} />}
            value={memberCount.toLocaleString()}
            label="Team members"
            hint={isAdmin ? "You are admin" : "Member access"}
          />
          <StatCard
            icon={<Plugs size={16} />}
            value={sourceCount}
            label="Sources connected"
            hint={sourceCount > 0 ? sourceTypes.map(sourceLabel).join(", ") : "No sources yet"}
          />
          <StatCard
            icon={<CheckCircle size={16} weight="fill" color="var(--a-olive)" />}
            value="Active"
            label="Status"
            hint="All systems operational"
          />
        </div>

        <div className="a-ov-lower">
          <div>
            <SectionTitle
              aside={
                isAdmin ? (
                  <Link href="/admin/connections" style={{ fontSize: 13, color: "var(--a-muted)", display: "inline-flex", gap: 6, alignItems: "center" }}>
                    View connections
                    <ArrowRight size={14} />
                  </Link>
                ) : undefined
              }
            >
              Recent activity
            </SectionTitle>
            <div className="a-card a-clip a-divide">
              {activity.length === 0 ? (
                <div className="a-row" style={{ color: "var(--a-muted)", fontSize: 13 }}>
                  No ingestion runs yet. Connect a source and sync to see activity here.
                </div>
              ) : (
                activity.map((a, i) => (
                  <div key={i} className="a-row">
                    <span className={`a-dot6 ${a.tone === "ok" ? "" : a.tone}`} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14 }}>{a.label}</div>
                      <div style={{ fontSize: 12, marginTop: 2, color: a.tone === "err" ? "var(--a-danger)" : "var(--a-muted)" }}>{a.sub}</div>
                    </div>
                    <span style={{ fontSize: 12, color: "var(--a-muted)", flexShrink: 0 }}>{a.time}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <SectionTitle>Quick actions</SectionTitle>
            <div className="a-card a-clip a-divide">
              {actions.map((action) => (
                <Link key={action.href} href={action.href} className="a-row-link">
                  <Tile>{action.icon}</Tile>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14 }}>{action.label}</div>
                    <div style={{ fontSize: 12, color: "var(--a-muted)" }}>{action.sub}</div>
                  </div>
                  <CaretRight size={14} color="var(--a-muted)" />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </AppPage>
    </DashboardShell>
  );
}
