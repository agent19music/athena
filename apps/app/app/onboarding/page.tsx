"use client";

import { useClerk, useOrganization } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import PageFadeIn from "@/components/PageFadeIn";

const inputStyle = (focused: boolean): React.CSSProperties => ({
  width: "100%",
  height: 48,
  borderRadius: "var(--radius-md)",
  border: `1px solid ${focused ? "var(--foreground)" : "var(--border-strong)"}`,
  background: "var(--background)",
  color: "var(--foreground)",
  fontSize: 15,
  fontWeight: 400,
  padding: "0 var(--space-4)",
  outline: "none",
  fontFamily: "var(--font-sans)",
  transition: "border-color 150ms ease-out",
  boxSizing: "border-box",
});

function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
        <label style={{ fontSize: 13, color: "var(--foreground-muted)", fontFamily: "var(--font-sans)" }}>
          {label}
        </label>
        {optional && (
          <span style={{ fontSize: 12, color: "var(--foreground-subtle)", fontFamily: "var(--font-sans)" }}>
            optional
          </span>
        )}
      </div>
      {children}
      {hint && (
        <p style={{ fontSize: 12, color: "var(--foreground-subtle)", fontFamily: "var(--font-sans)", margin: 0 }}>
          {hint}
        </p>
      )}
    </div>
  );
}

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
  const [focused, setFocused] = useState<string | null>(null);
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
    <div
      style={{
        minHeight: "100svh",
        background: "var(--background)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-8) var(--space-6)",
      }}
    >
      <PageFadeIn
        style={{
          width: "100%",
          maxWidth: 480,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-8)",
        }}
      >
        <Link href="/" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 8 }}>
          <Image src="/athena-mind-logo.png" alt="Athena" width={36} height={36} />
          <span style={{ fontSize: 15, letterSpacing: "-0.01em", color: "var(--foreground)" }}>
            Athena
          </span>
        </Link>

        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-lg)",
            padding: "var(--space-8)",
          }}
        >
          <h1
            style={{
              fontSize: 22,
              letterSpacing: "-0.01em",
              color: "var(--foreground)",
              marginBottom: "var(--space-2)",
              fontFamily: "var(--font-sans)",
            }}
          >
            Set up your organisation
          </h1>
          <p
            style={{
              fontSize: 14,
              color: "var(--foreground-muted)",
              lineHeight: 1.6,
              marginBottom: "var(--space-8)",
              fontFamily: "var(--font-sans)",
            }}
          >
            Name your workspace. You can connect sources and upload files once you are in.
          </p>

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
            <Field label="Organisation name">
              <input
                type="text"
                required
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                onFocus={() => setFocused("orgName")}
                onBlur={() => setFocused(null)}
                placeholder="Acme Corp"
                style={inputStyle(focused === "orgName")}
              />
            </Field>

            <Field label="Logo URL" optional hint="Paste a public image URL. PNG or SVG works best.">
              <input
                type="url"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                onFocus={() => setFocused("logo")}
                onBlur={() => setFocused(null)}
                placeholder="https://acme.com/logo.png"
                style={inputStyle(focused === "logo")}
              />
            </Field>

            {error && (
              <p style={{ fontSize: 13, color: "#dc2626", fontFamily: "var(--font-sans)", margin: 0 }}>
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={submitting || !orgName.trim()}
              variant="primary-dark"
              size="lg"
              full
            >
              {submitting ? "Creating organisation…" : "Create organisation"}
            </Button>
          </form>
        </div>
      </PageFadeIn>
    </div>
  );
}
