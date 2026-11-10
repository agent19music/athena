"use client";

import { useClerk, useOrganization } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, WarningCircle } from "@phosphor-icons/react";
import { Field } from "@/components/athena/ui";

async function finishOnboarding(body: Record<string, unknown>) {
  const res = await fetch("/api/orgs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? "Something went wrong. Please try again.");
  }
  return data as { isNew?: boolean; org_id?: string; promoGranted?: boolean };
}

const PROMO_TOAST_KEY = "athena:promo-toast";

function stashPromoToast(granted: boolean | undefined) {
  if (!granted) return;
  try {
    sessionStorage.setItem(PROMO_TOAST_KEY, "1");
  } catch {
    // Private mode — the ?promo=1 query still carries the toast.
  }
}

function billingHref(promoGranted: boolean | undefined) {
  return promoGranted ? "/admin/billing?promo=1" : "/admin/billing?welcome=1";
}

export default function OnboardingPage() {
  const router = useRouter();
  const { setActive } = useClerk();
  const { organization, isLoaded } = useOrganization();
  const autoSkipStarted = useRef(false);

  // Already onboarded → dashboard.
  useEffect(() => {
    if (!isLoaded) return;
    if (organization?.publicMetadata?.onboarded === true) {
      router.replace("/dashboard");
    }
  }, [isLoaded, organization, router]);

  // Org exists but not marked onboarded → finish without the old "connect sources" step.
  useEffect(() => {
    if (!isLoaded || !organization) return;
    if (organization.publicMetadata?.onboarded === true) return;
    if (autoSkipStarted.current) return;
    autoSkipStarted.current = true;

    (async () => {
      try {
        const data = await finishOnboarding({
          orgName: organization.name,
          logoUrl: null,
          notionApiKey: null,
          notionRootPageId: null,
          publicDocIds: [],
          tallyApiKey: null,
          tallyFormIds: [],
        });
        stashPromoToast(data.promoGranted);
        router.replace(billingHref(data.promoGranted));
      } catch {
        // Fall through to a minimal org card if auto-skip fails.
        autoSkipStarted.current = false;
      }
    })();
  }, [isLoaded, organization, router]);

  const [orgName, setOrgName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isLoaded && organization?.name && !orgName) {
      setOrgName(organization.name);
    }
  }, [isLoaded, organization, orgName]);

  if (!isLoaded) return null;
  if (organization?.publicMetadata?.onboarded === true) return null;

  // Existing org: show nothing while we auto-skip to billing.
  if (organization) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const data = await finishOnboarding({
        orgName: orgName.trim(),
        logoUrl: logoUrl || null,
        notionApiKey: null,
        notionRootPageId: null,
        publicDocIds: [],
        tallyApiKey: null,
        tallyFormIds: [],
      });

      stashPromoToast(data.promoGranted);
      if (data.isNew && data.org_id) {
        await setActive({ organization: data.org_id });
      }

      router.push(billingHref(data.promoGranted));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect. Check your internet and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="a-root a-split">
      <div className="a-split-form">
        <div style={{ width: "100%", maxWidth: 400 }}>
          <Link href="/" className="a-split-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/athena-knot.svg" alt="" width={28} height={28} />
            <span>Athena</span>
          </Link>
          <div className="a-kicker" style={{ marginBottom: 12 }}>Step 1 of 2</div>
          <h1 className="a-serif a-split-h">Create your organisation</h1>
          <p className="a-split-p">
            Your organisation holds your team, your connected sources and your plan. You can change these later in Settings.
          </p>

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 28 }}>
            <Field label="Organisation name" htmlFor="onb-org">
              <div className="a-input">
                <input
                  id="onb-org"
                  type="text"
                  required
                  autoFocus
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Acme Corp"
                />
              </div>
            </Field>

            <div className="a-field">
              <label className="a-label" htmlFor="onb-logo">
                Logo URL <span style={{ color: "var(--a-faint)" }}>(optional)</span>
              </label>
              <div className="a-input">
                <input
                  id="onb-logo"
                  type="url"
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder="https://"
                />
              </div>
              <span style={{ fontSize: 12, color: "var(--a-muted)" }}>Paste a public image URL. PNG or SVG works best.</span>
            </div>

            {error && (
              <div className="a-notice err" role="alert">
                <WarningCircle size={14} weight="fill" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              className="a-btn a-btn-primary a-btn-lg a-btn-block"
              style={{ marginTop: 8 }}
              disabled={submitting || !orgName.trim()}
            >
              {submitting ? "Creating organisation…" : "Create organisation"}
              {!submitting && <ArrowRight size={14} />}
            </button>
            <p style={{ fontSize: 12, color: "var(--a-muted)", textAlign: "center" }}>
              Next, choose a plan. Every plan starts with a 7-day free trial.
            </p>
          </form>
        </div>
      </div>

      <div className="a-split-art">
        <div className="frame">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/dither-temple-blue.webp" alt="Blue-dithered Greek temple" />
          <div className="a-split-card a-only-d">
            <div className="a-ac" style={{ padding: "16px 18px" }}>
              <div className="a-ac-k">Ask Athena</div>
              <div className="a-ac-q">What is our leave policy for annual leave?</div>
              <div className="a-ac-k" style={{ marginTop: 14 }}>Answer</div>
              <div className="a-ac-a">
                Full-time staff get 21 working days a year. Requests go through the HR portal two weeks ahead and your line manager approves them.
              </div>
              <div className="a-ac-chips">
                <span className="a-chip">Notion · Leave policy</span>
                <span className="a-chip">Drive · leave_policy.md</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
