"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { initializePaddle, type Paddle } from "@paddle/paddle-js";
import { Check, CreditCard, WarningCircle } from "@phosphor-icons/react";
import DashboardShell, { AppPage } from "../../../components/DashboardShell";
import { ConfirmDialog } from "../../../components/athena/ConfirmDialog";
import { Badge, PageHeader, Tile } from "../../../components/athena/ui";
import { Toast } from "../../../components/Toast";
import { getPaymentDetails } from "../../../lib/athena-ui-mocks";
import {
  isPaidEntitlement,
  normalizePlan,
  type BillingEntitlement,
} from "../../../lib/billing";
import {
  requirePaddleClientToken,
  requirePaddleEnvironment,
} from "../../../lib/paddle-env";
import {
  TIERS,
  type BillingInterval,
  type Tier,
} from "../../../lib/pricing-tiers";

// Plan card copy from the Doop billing frame. Kept here (not in
// lib/pricing-tiers, which marketing shares) so the app can match the design
// without changing the public pricing page.
const PLAN_COPY: Record<Tier["id"], { description: string; features: string[]; badge?: string }> = {
  starter: {
    description: "For small teams starting with Notion and Google Docs.",
    features: ["Notion and Google Docs", "10 uploaded files", "2,500 document chunks", "Up to 20 members", "2 data sources", "Manual sync", "Community support"],
  },
  pro: {
    description: "For growing teams with more sources and files.",
    features: ["Everything in Starter", "50 uploaded files", "8,000 document chunks", "Up to 40 members", "4 data sources", "Google Drive connector", "Email support"],
  },
  advanced: {
    description: "For organisations that need scale and weekly sync.",
    features: ["Everything in Pro", "2,000 uploaded files", "80,000 document chunks", "Up to 200 members", "Unlimited sources", "Weekly auto-sync", "Priority support"],
    badge: "Most capacity",
  },
};

function UsageBar({ label, used, max }: { label: string; used: number; max: number | null }) {
  const pct = max == null ? 0 : Math.min((used / Math.max(max, 1)) * 100, 100);
  const warn = max != null && used / Math.max(max, 1) > 0.9;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 8, gap: 8 }}>
        <span>{label}</span>
        <span className="a-num">
          {used.toLocaleString()}
          <span style={{ color: "var(--a-muted)" }}>{max == null ? " / Unlimited" : ` / ${max.toLocaleString()}`}</span>
        </span>
      </div>
      <div className={`a-bar${warn ? " warn" : ""}`}>
        <span style={{ width: max == null ? "4%" : `${pct}%` }} />
      </div>
      <div style={{ fontSize: 12, color: warn ? "var(--a-amber)" : "var(--a-muted)", marginTop: 6 }}>
        {max == null ? "Unlimited" : `${Math.round(pct)}% used`}
      </div>
    </div>
  );
}

function RedeemPanel({ onRedeemed }: { onRedeemed: (e: BillingEntitlement) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function redeem() {
    setBusy(true);
    setError("");
    setOk("");
    try {
      const res = await fetch("/api/billing/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg =
          typeof data.detail === "string"
            ? data.detail
            : data.error || data.detail?.message || data.message || "Could not redeem code";
        throw new Error(msg);
      }
      setOk("Pro unlocked for 30 days.");
      onRedeemed(data as BillingEntitlement);
      setCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not redeem code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="a-card a-card-pad" style={{ marginBottom: 40 }}>
      <div style={{ fontSize: 16, marginBottom: 4 }}>Redeem a promo code</div>
      <div style={{ fontSize: 13, color: "var(--a-muted)", marginBottom: 16 }}>
        Early access codes grant a month of Pro with no card required.
      </div>
      <form
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        onSubmit={(e) => { e.preventDefault(); if (code.trim()) redeem(); }}
      >
        <div className="a-input" style={{ flex: 1, minWidth: 180 }}>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ATHENA-EARLY" aria-label="Promo code" />
        </div>
        <button type="submit" className="a-btn a-btn-primary" style={{ height: 40 }} disabled={busy || !code.trim()}>
          {busy ? "Redeeming…" : "Redeem"}
        </button>
      </form>
      {error && <p style={{ fontSize: 13, color: "var(--a-danger)", marginTop: 10 }}>{error}</p>}
      {ok && <p style={{ fontSize: 13, color: "var(--a-status-ok)", marginTop: 10 }}>{ok}</p>}
    </div>
  );
}

type Props = {
  initial: BillingEntitlement;
  orgName?: string | null;
  countryCode?: string;
  customerEmail?: string | null;
};

export default function BillingClient({
  initial,
  orgName,
  countryCode,
  customerEmail,
}: Props) {
  const router = useRouter();
  const [entitlement, setEntitlement] = useState(initial);
  const [welcomeTrial, setWelcomeTrial] = useState(false);
  const [gifted, setGifted] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("promo") === "1";
    let fromStore = false;
    try {
      fromStore = sessionStorage.getItem("athena:promo-toast") === "1";
      if (fromStore) sessionStorage.removeItem("athena:promo-toast");
    } catch {
      fromStore = false;
    }
    if (fromQuery || fromStore) {
      setGifted(true);
      setToast("This one is on us");
    }
    if (fromQuery) {
      params.delete("promo");
      const next = params.toString();
      window.history.replaceState(
        null,
        "",
        next ? `${window.location.pathname}?${next}` : window.location.pathname,
      );
    }
    if (params.get("welcome") === "1" || params.get("trial") === "1") {
      setWelcomeTrial(true);
    }
  }, []);
  const [interval, setInterval] = useState<BillingInterval>("year");
  const [paddle, setPaddle] = useState<Paddle | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [loadingPrices, setLoadingPrices] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [configError, setConfigError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"starter" | "pro" | "advanced">("advanced");
  const [cancelOpen, setCancelOpen] = useState(false);
  const payment = getPaymentDetails();
  const paddleRef = useRef<Paddle | null>(null);
  const checkoutLockRef = useRef<{
    transactionId: string;
    quantity: number;
    priceId: string;
  } | null>(null);

  const plan = normalizePlan(entitlement.plan);
  const isPaid = isPaidEntitlement(entitlement);
  const limits = entitlement.limits;
  const periodLabel = entitlement.period_end
    ? new Date(entitlement.period_end).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const environment = requirePaddleEnvironment();
        const token = requirePaddleClientToken();
        const instance = await initializePaddle({
          environment,
          token,
          ...(initial.paddle_customer_id
            ? { pwCustomer: { id: initial.paddle_customer_id } }
            : {}),
          eventCallback: (event) => {
            const lock = checkoutLockRef.current;
            const live = paddleRef.current;
            if (!lock || !event.data) return;
            if (event.data.transaction_id !== lock.transactionId) return;

            const qty = event.data.items?.[0]?.quantity;
            const qtyChanged = typeof qty === "number" && qty !== lock.quantity;
            if (qtyChanged) {
              live?.Checkout.updateItems([{ priceId: lock.priceId, quantity: lock.quantity }]);
            }

            if (qtyChanged || event.data.status === "ready") {
              void fetch("/api/billing/lock-checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ transaction_id: lock.transactionId }),
              }).catch((err) => {
                console.error("lock-checkout failed", err);
              });
            }

            if (event.name === "checkout.completed" || event.name === "checkout.closed") {
              checkoutLockRef.current = null;
            }
          },
        });
        if (!cancelled && instance) {
          paddleRef.current = instance;
          setPaddle(instance);
        }
      } catch (err) {
        if (!cancelled) {
          setConfigError(
            err instanceof Error ? err.message : "Paddle failed to initialize.",
          );
          setLoadingPrices(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!paddle) return;
    let cancelled = false;
    (async () => {
      setLoadingPrices(true);
      try {
        const preview = await paddle.PricePreview({
          items: TIERS.map((t) => ({
            priceId: t.priceId[interval],
            quantity: 1,
          })),
          ...(countryCode ? { address: { countryCode } } : {}),
        });
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const line of preview.data.details.lineItems) {
          next[line.price.id] = line.formattedTotals.total;
        }
        setPrices(next);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not load localized prices.",
          );
        }
      } finally {
        if (!cancelled) setLoadingPrices(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paddle, interval, countryCode]);

  async function refresh() {
    try {
      const res = await fetch("/api/billing/entitlement", { cache: "no-store" });
      if (res.ok) setEntitlement(await res.json());
    } catch {
      /* keep current */
    }
    router.refresh();
  }

  async function subscribe(tier: Tier) {
    if (!paddle) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: tier.id, interval }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof data.detail === "string"
            ? data.detail
            : data.error || "Could not start checkout",
        );
      }
      const transactionId = data.transaction_id as string | undefined;
      const quantity = Math.max(1, Number(data.quantity) || entitlement.members || 1);
      const priceId = (data.price_id as string | undefined) || tier.priceId[interval];
      if (!transactionId) throw new Error("Could not start checkout");

      checkoutLockRef.current = { transactionId, quantity, priceId };
      paddle.Checkout.open({
        transactionId,
        ...(customerEmail ? { customer: { email: customerEmail } } : {}),
        settings: {
          displayMode: "overlay",
          variant: "one-page",
          successUrl: `${window.location.origin}/admin/billing?upgraded=1`,
        },
      });
      setTimeout(() => refresh(), 2500);
    } catch (err) {
      checkoutLockRef.current = null;
      setError(err instanceof Error ? err.message : "Checkout failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancelSub() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/billing/cancel", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Could not cancel");
      await refresh();
      setToast(periodLabel ? `Plan cancelled. You keep access until ${periodLabel}.` : "Plan cancelled at period end.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setBusy(false);
      setCancelOpen(false);
    }
  }

  const rank = { starter: 0, pro: 1, advanced: 2 } as const;

  function tierCta(tier: Tier) {
    const current = plan === tier.id && isPaid;
    if (current) {
      return (
        <span className="a-btn a-btn-secondary a-btn-block" aria-disabled="true" style={{ cursor: "default", opacity: 1 }}>
          <Check size={14} />
          Current plan
        </span>
      );
    }
    if (isPaid && rank[plan] > rank[tier.id]) {
      return (
        <span className="a-btn a-btn-secondary a-btn-block" style={{ color: "var(--a-muted)", cursor: "default" }}>
          Included in {plan === "advanced" ? "Advanced" : "Pro"}
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={() => subscribe(tier)}
        className={`a-btn a-btn-block ${tier.id === "advanced" || !isPaid ? "a-btn-primary" : "a-btn-secondary"}`}
        disabled={busy || !!configError || !paddle || loadingPrices}
      >
        {busy ? "Opening…" : `Subscribe to ${tier.name}`}
      </button>
    );
  }

  function TierCard({ tier }: { tier: Tier }) {
    const copy = PLAN_COPY[tier.id];
    const priceId = tier.priceId[interval];
    const formatted = prices[priceId];
    const priceLabel = loadingPrices ? "…" : formatted ?? "—";
    return (
      <div className={`a-card a-plan${copy.badge ? " hl" : ""}`}>
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 18 }}>{tier.name}</span>
            {copy.badge && <Badge tone="ink" dot={false}>{copy.badge}</Badge>}
          </div>
          <div className="a-plan-desc">{copy.description}</div>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
          <span className="a-serif a-num" style={{ fontSize: 40, letterSpacing: "-0.02em", lineHeight: 1 }}>{priceLabel}</span>
          <span style={{ fontSize: 13, color: "var(--a-muted)" }}>/ user / {interval === "month" ? "mo" : "yr"}</span>
        </div>
        {tierCta(tier)}
        <ul className="a-plan-list">
          {copy.features.map((f) => (
            <li key={f}>
              <Check size={14} color="var(--a-olive)" style={{ flexShrink: 0, marginTop: 3 }} />
              <span>{f}</span>
            </li>
          ))}
        </ul>
        <div style={{ fontSize: 12, color: "var(--a-muted)", marginTop: "auto" }}>7-day free trial</div>
      </div>
    );
  }

  const seats = entitlement.seats_billed || entitlement.members;
  const status = entitlement.status;
  const planLine = !isPaid
    ? "Choose a plan to start. Every plan includes a 7-day free trial."
    : [
        periodLabel
          ? status === "canceled"
            ? `Access until ${periodLabel}`
            : status === "trialing"
              ? `Trial ends and billing starts ${periodLabel}`
              : entitlement.source === "promo"
                ? `Promo ends ${periodLabel}`
                : `Renews ${periodLabel}`
          : null,
        `${seats} seat${seats === 1 ? "" : "s"}`,
        entitlement.source === "paddle" ? "Billed through Paddle" : entitlement.source === "promo" ? "Promo code" : null,
      ]
        .filter(Boolean)
        .join(" · ");
  const canCancel = isPaid && entitlement.source === "paddle" && status !== "canceled";

  return (
    <DashboardShell>
      <AppPage>
        <PageHeader
          title="Billing"
          sub={`Your plan, usage and invoices${orgName ? ` for ${orgName}` : ""}.`}
          subMobile="Your plan, usage and invoices."
        />

        {(welcomeTrial || !isPaid) && !gifted && (
          <div className="a-notice" style={{ marginBottom: 20 }} role="status">
            <WarningCircle size={14} weight="fill" />
            <span>
              {welcomeTrial ? "Welcome to Athena. " : ""}
              Every plan includes a 7-day free trial. Start a trial to connect Notion, Tally, and other sources, and to upload files.
              There is no free plan. Pick Starter, Pro, or Advanced below.
            </span>
          </div>
        )}

        <div className="a-card a-plan-current">
          <div className="a-kicker" style={{ marginBottom: 8 }}>Current plan</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="a-serif" style={{ fontSize: 28, letterSpacing: "-0.02em", lineHeight: 1.2 }}>{entitlement.plan_name}</span>
            {status === "canceled" && <Badge tone="err">Cancelled</Badge>}
            {status === "past_due" && <Badge tone="err">Past due</Badge>}
          </div>
          <div style={{ fontSize: 13, color: "var(--a-muted)", marginTop: 6 }}>{planLine}</div>

          {(error || configError) && (
            <div className="a-notice err" style={{ marginTop: 16 }}>
              <WarningCircle size={14} weight="fill" />
              <span>{configError || error}</span>
            </div>
          )}

          <div className="a-usage">
            <UsageBar label="Document chunks" used={entitlement.chunks} max={limits.chunks} />
            <UsageBar label="Team members" used={entitlement.members} max={limits.seats} />
            <UsageBar label="Uploaded files" used={entitlement.files} max={limits.upload_files} />
            <UsageBar label="Data sources" used={entitlement.source_count} max={limits.source_types} />
          </div>
        </div>

        {!isPaid && (
          <RedeemPanel
            onRedeemed={(e) => {
              setEntitlement(e);
              router.refresh();
            }}
          />
        )}

        <div className="a-sec-t">
          <h2>Plans</h2>
          <div className="a-seg" role="group" aria-label="Billing interval">
            {([
              { id: "month", label: "Monthly" },
              { id: "year", label: "Yearly" },
            ] as const).map((opt) => (
              <button key={opt.id} type="button" aria-pressed={interval === opt.id} onClick={() => setInterval(opt.id)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="a-seg block a-only-m a-plan-tabs" role="tablist" aria-label="Plans">
          {TIERS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={activeTab === t.id} onClick={() => setActiveTab(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
        <div className="a-plans a-only-d">
          {TIERS.map((tier) => <TierCard key={tier.id} tier={tier} />)}
        </div>
        <div className="a-only-m">
          {TIERS.filter((t) => t.id === activeTab).map((tier) => <TierCard key={tier.id} tier={tier} />)}
        </div>
        <p style={{ fontSize: 12, color: "var(--a-muted)", marginTop: 12 }}>
          {interval === "month"
            ? "Prices in USD per user per month. Paddle shows your local currency and tax at checkout."
            : "Prices per user per year. Paddle shows your local currency and tax at checkout."}
        </p>

        {payment && (
          <>
            <div className="a-sec-t a-bill-gap">
              <h2>
                Payment details <Badge>Admins only</Badge>
              </h2>
            </div>
            <div className="a-card a-pay">
              <div className="a-pay-row">
                <div className="k">Card on file</div>
                <div className="v" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  {payment.card.brand === "visa" && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src="/icons/visa.svg" alt="Visa" style={{ height: 14, width: "auto", display: "block" }} />
                  )}
                  <span className="a-num">•••• {payment.card.last4}</span>
                  <span style={{ color: "var(--a-muted)", fontSize: 13 }}>Expires {payment.card.expires}</span>
                </div>
              </div>
              <div className="a-pay-row"><div className="k">Billing email</div><div className="v">{payment.billingEmail}</div></div>
              <div className="a-pay-row"><div className="k">Billing address</div><div className="v">{payment.billingAddress}</div></div>
              {payment.taxId && <div className="a-pay-row"><div className="k">Tax ID</div><div className="v">{payment.taxId}</div></div>}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 4 }}>
                <div style={{ fontSize: 12, color: "var(--a-muted)" }}>Managed securely by Paddle</div>
                <button type="button" className="a-btn a-btn-secondary a-btn-sm" disabled title="Payment method updates aren't wired to an API yet">
                  Update payment method
                </button>
              </div>
            </div>
          </>
        )}

        <div className="a-sec-t a-bill-gap"><h2>Billing history</h2></div>
        <div className="a-card a-bill-empty">
          <Tile><CreditCard size={16} /></Tile>
          <div>
            <div style={{ fontSize: 14 }}>No invoices yet</div>
            <div style={{ fontSize: 13, color: "var(--a-muted)", marginTop: 2 }}>
              {isPaid && entitlement.source === "paddle"
                ? "Invoices appear in the Paddle customer portal after each successful charge."
                : "Subscribe above to start. Invoices appear after each successful charge."}
            </div>
          </div>
        </div>

        {canCancel && (
          <div className="a-bill-manage">
            <div style={{ fontSize: 13, color: "var(--a-muted)", marginBottom: 8 }}>Manage subscription</div>
            <button type="button" className="a-text-btn" style={{ fontSize: 13, color: "var(--a-ink)", textUnderlineOffset: 3 }} onClick={() => setCancelOpen(true)} disabled={busy}>
              Cancel at period end
            </button>
            <div style={{ fontSize: 12, color: "var(--a-faint)", marginTop: 8 }}>Visible to organisation admins only.</div>
          </div>
        )}
      </AppPage>

      <ConfirmDialog
        open={cancelOpen}
        icon={<WarningCircle size={18} weight="fill" />}
        title={`Cancel your ${entitlement.plan_name} plan?`}
        body={`You keep ${entitlement.plan_name} until ${periodLabel ?? "the end of this billing period"}. After that, your team loses access to Athena until you choose a plan again.`}
        confirmLabel={busy ? "Cancelling…" : "Cancel plan"}
        busy={busy}
        onCancel={() => setCancelOpen(false)}
        onConfirm={cancelSub}
      />
      <Toast message={toast} onDismiss={() => setToast(null)} tone="success" />
    </DashboardShell>
  );
}
