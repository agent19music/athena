import { auth, currentUser } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import BillingClient from "./BillingClient";
import { normalizePlan, type BillingEntitlement } from "../../../lib/billing";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";

const FALLBACK: BillingEntitlement = {
  plan: "starter",
  plan_name: "Starter",
  status: "active",
  source: null,
  period_end: null,
  seats_billed: 1,
  paddle_customer_id: null,
  paddle_subscription_id: null,
  chunks: 0,
  files: 0,
  members: 1,
  sources: [],
  source_count: 0,
  limits: {
    seats: 20,
    chunks: 2500,
    upload_files: 10,
    source_types: 2,
    drive: false,
    price_per_seat_usd_cents: 1000,
  },
  client_token: process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? null,
  environment: process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT ?? "",
  price_id: null,
};

function countryFromHeaders(h: Headers): string | undefined {
  const raw =
    h.get("x-vercel-ip-country") ||
    h.get("cf-ipcountry") ||
    h.get("x-country-code");
  if (!raw) return undefined;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return undefined;
  if (code === "XX" || code === "T1") return undefined;
  return code;
}

export default async function BillingPage() {
  const { userId, orgId, getToken } = await auth();

  if (!userId) redirect("/login");
  if (!orgId) redirect("/onboarding");

  const h = await headers();
  const countryCode = countryFromHeaders(h);

  let customerEmail: string | null = null;
  try {
    const user = await currentUser();
    customerEmail =
      user?.primaryEmailAddress?.emailAddress ??
      user?.emailAddresses?.[0]?.emailAddress ??
      null;
  } catch {
    customerEmail = null;
  }

  let entitlement: BillingEntitlement = { ...FALLBACK, members: 1 };
  let orgName: string | null = null;

  try {
    const token = await getToken();
    if (token) {
      const res = await fetch(`${BACKEND_URL}/billing/entitlement`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        entitlement = {
          ...FALLBACK,
          ...data,
          plan: normalizePlan(data.plan),
        };
      }
    }
  } catch {
    /* use fallback */
  }

  try {
    const { clerkClient } = await import("@clerk/nextjs/server");
    const client = await clerkClient();
    // totalCount preferred; membership list itself is capped at 100.
    const memberships = await client.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      limit: 100,
    });
    const clerkCount = memberships.totalCount ?? memberships.data.length;
    orgName = memberships.data[0]?.organization?.name ?? null;
    if (clerkCount > 0) {
      entitlement = { ...entitlement, members: clerkCount };
    }
  } catch {
    /* keep backend count */
  }

  return (
    <BillingClient
      initial={entitlement}
      orgName={orgName}
      countryCode={countryCode}
      customerEmail={customerEmail}
    />
  );
}
