import { auth, clerkClient } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

export async function PATCH(request: NextRequest) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await request.json();
  if (!name?.trim()) return NextResponse.json({ error: "Name required" }, { status: 400 });

  const client = await clerkClient();
  await client.organizations.updateOrganization(orgId, { name: name.trim() });
  return NextResponse.json({ ok: true });
}

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";

export async function POST(request: NextRequest) {
  const { userId, orgId: existingOrgId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { orgName, logoUrl, notionApiKey, notionRootPageId, publicDocIds, tallyApiKey, tallyFormIds } = body;

  const client = await clerkClient();
  let orgId: string;
  let name: string;
  const isNew = !existingOrgId;

  if (existingOrgId) {
    // Org already exists (created by Clerk's sign-up UI) — use it
    orgId = existingOrgId;
    const org = await client.organizations.getOrganization({ organizationId: orgId });
    name = org.name;
  } else {
    // First time — create the org
    if (!orgName?.trim()) {
      return NextResponse.json({ error: "Organisation name is required" }, { status: 400 });
    }
    try {
      const org = await client.organizations.createOrganization({
        name: orgName.trim(),
        createdBy: userId,
      });
      orgId = org.id;
      name = org.name;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create organisation";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // Persist org on the backend. Only kick off ingest when onboarding actually
  // supplied sources — otherwise create_ingest_job would open an empty "running"
  // job for nothing. The ensure endpoint (same /ingest with no sources still
  // needs an org row) is handled by POST /organizations/ensure below.
  const notionKey = notionApiKey?.trim() || null;
  const notionRoot = notionRootPageId?.trim() || null;
  const docs = Array.isArray(publicDocIds) ? publicDocIds.filter(Boolean) : [];
  const tallyKey = tallyApiKey?.trim() || null;
  const tallyForms = Array.isArray(tallyFormIds) ? tallyFormIds.filter(Boolean) : [];
  const hasSources = Boolean(
    (notionKey && notionRoot) || docs.length > 0 || (tallyKey && tallyForms.length > 0),
  );

  const backendApiSecret = process.env.BACKEND_API_SECRET ?? "";
  const backendHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(backendApiSecret ? { "X-API-Key": backendApiSecret } : {}),
  };

  // Promo is granted here, not from the browser and not from the Clerk webhook.
  // createOrganization does not put org_id on the session JWT until setActive,
  // so /billing/redeem (which reads the token) 401s in that window. The webhook
  // is async and also fires for orgs that are not a fresh signup.
  async function grantSignupPromo(): Promise<boolean> {
    try {
      const res = await fetch(`${BACKEND_URL}/billing/grant-signup`, {
        method: "POST",
        headers: backendHeaders,
        body: JSON.stringify({ org_id: orgId, clerk_user_id: userId }),
      });
      if (!res.ok) {
        console.error(`Signup promo failed for org ${orgId}:`, await res.text());
        return false;
      }
      const data = await res.json().catch(() => ({}));
      return data.granted === true;
    } catch (err) {
      console.error("Could not grant signup promo:", err);
      return false;
    }
  }

  let promoGranted = false;

  try {
    if (hasSources) {
      // Grant before ingest so the plan gate sees Pro. The grant endpoint
      // creates the organizations row if the webhook has not arrived yet.
      promoGranted = await grantSignupPromo();
      const res = await fetch(`${BACKEND_URL}/ingest`, {
        method: "POST",
        headers: backendHeaders,
        body: JSON.stringify({
          org_id: orgId,
          org_name: name,
          org_logo_url: logoUrl?.trim() || null,
          notion_api_key: notionKey,
          notion_root_page_id: notionRoot,
          public_doc_ids: docs,
          tally_api_key: tallyKey,
          tally_form_ids: tallyForms,
          trigger: "onboarding",
        }),
      });
      if (!res.ok) {
        console.error(`Ingest failed for org ${orgId}:`, await res.text());
      }
    } else {
      const res = await fetch(`${BACKEND_URL}/organizations/ensure`, {
        method: "POST",
        headers: backendHeaders,
        body: JSON.stringify({
          org_id: orgId,
          org_name: name,
          org_logo_url: logoUrl?.trim() || null,
        }),
      });
      if (!res.ok) {
        console.error(`Ensure org failed for ${orgId}:`, await res.text());
      }
      promoGranted = await grantSignupPromo();
    }
  } catch (err) {
    console.error("Could not reach backend during onboarding:", err);
  }

  // Mark this org as fully onboarded
  try {
    await client.organizations.updateOrganization(orgId, {
      publicMetadata: { onboarded: true },
    });
  } catch (err) {
    console.error("Could not set onboarded metadata:", err);
    // Non-fatal — user can still proceed, they'll hit onboarding again on next load
  }

  return NextResponse.json({ org_id: orgId, name, isNew, promoGranted });
}
