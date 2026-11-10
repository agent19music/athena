import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Plugs } from "@phosphor-icons/react/dist/ssr";
import DashboardShell, { AppPage } from "../../components/DashboardShell";
import { BtnLink, Tile } from "../../components/athena/ui";
import ChatClient from "./ChatClient";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { userId, orgId, orgRole, getToken } = await auth();

  if (!userId) redirect("/login");
  if (!orgId) redirect("/onboarding");

  const isAdmin = orgRole === "org:admin";
  const sp = await searchParams;
  const initialQuery = typeof sp.q === "string" && sp.q.trim() ? sp.q.trim().slice(0, 2000) : null;

  // Gate chat behind having at least one ingested source — otherwise every
  // query is guaranteed to be a "no documentation found" miss. Fails open
  // (chunkCount stays null) on any fetch error so a flaky backend blocks
  // nobody; only a confirmed zero hides the chat UI.
  let chunkCount: number | null = null;
  let sourceCount: number | null = null;
  let suggestions: string[] = [];
  try {
    const token = await getToken();
    if (token) {
      const headers = { Authorization: `Bearer ${token}` };
      const statsRes = await fetch(`${BACKEND_URL}/stats`, {
        headers,
        cache: "no-store",
      });
      if (statsRes.ok) {
        const stats = await statsRes.json();
        chunkCount = stats.chunk_count ?? null;
        sourceCount = Array.isArray(stats.source_types) ? stats.source_types.length : null;
      }
      if (chunkCount !== 0) {
        const suggestRes = await fetch(`${BACKEND_URL}/suggested-questions`, {
          headers,
          cache: "no-store",
        });
        if (suggestRes.ok) {
          const body = await suggestRes.json();
          suggestions = Array.isArray(body.questions) ? body.questions.filter((q: unknown) => typeof q === "string") : [];
        }
      }
    }
  } catch {
    /* chunkCount stays null — fail open */
  }

  if (chunkCount === 0) {
    return (
      <DashboardShell>
        <AppPage narrow>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "72px 0", gap: 16 }}>
            <Tile lg><Plugs size={18} /></Tile>
            <div>
              <h1 className="a-serif" style={{ fontSize: 28, lineHeight: 1.2, letterSpacing: "-0.02em" }}>No knowledge sources connected yet</h1>
              <p style={{ fontSize: 15, color: "var(--a-muted)", lineHeight: 1.55, maxWidth: 440, margin: "10px auto 0" }}>
                {isAdmin
                  ? "Chat needs something to search. Connect Notion, a Google Doc, or upload a file first, then come back here."
                  : "Chat needs something to search. Ask an admin on your team to connect a data source first."}
              </p>
            </div>
            {isAdmin && (
              <BtnLink href="/admin/connections" variant="primary" size="lg" style={{ marginTop: 8 }}>
                Connect a source
              </BtnLink>
            )}
          </div>
        </AppPage>
      </DashboardShell>
    );
  }

  return <ChatClient suggestions={suggestions} sourceCount={sourceCount} initialQuery={initialQuery} />;
}
