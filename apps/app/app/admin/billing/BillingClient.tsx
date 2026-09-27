"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { initializePaddle, type Paddle } from "@paddle/paddle-js";
import { Button } from "../../../components/Button";
import DashboardShell from "../../../components/DashboardShell";
import PageFadeIn from "../../../components/PageFadeIn";
import { Toast } from "../../../components/Toast";
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

function UsageBar({ label, used, max }: { label: string; used: number; max: number | null }) {
  const capped = max == null ? 0 : Math.min((used / Math.max(max, 1)) * 100, 100);
  const warn = max != null && used / Math.max(max, 1) > 0.75;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, color: "#888", fontWeight: 400 }}>{label}</span>
        <span style={{ fontSize: 12.5, color: warn ? "#D97706" : "#aaa", fontVariantNumeric: "tabular-nums" }}>
          {used.toLocaleString()}
          {max == null ? " / Unlimited" : ` / ${max.toLocaleString()}`}
        </span>
      </div>
      <div style={{ height: 5, background: "#F0F0F0", borderRadius: 99, overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: max == null ? "8%" : `${capped}%`,
            background: warn
              ? "linear-gradient(90deg, #F59E0B, #FBBF24)"
              : "linear-gradient(90deg, #2563EB, #60A5FA)",
            borderRadius: 99,
            transition: "width 600ms ease-out",
          }}
        />
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
    <div
      style={{
        background: "#fff",
        border: "1px solid #E8E8E8",
        borderRadius: 12,
        padding: "24px 28px",
        marginBottom: 32,
        boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
      }}
    >
      <p style={{ fontSize: 16, fontWeight: 400, color: "#111", margin: "0 0 8px" }}>
        Redeem a promo code
      </p>
      <p style={{ fontSize: 13, color: "#888", margin: "0 0 16px", lineHeight: 1.5 }}>
        Early access codes grant a month of Pro with no card required.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ATHENA-EARLY"
          className="payment-input"
          style={{
            flex: 1,
            minWidth: 180,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #E5E5E5",
            fontSize: 14,
            fontWeight: 400,
            color: "#111",
            outline: "none",
          }}
        />
        <Button onClick={redeem} variant="primary-dark" disabled={busy || !code.trim()}>
          {busy ? "Redeeming…" : "Redeem"}
        </Button>
      </div>
      {error && <p style={{ fontSize: 12.5, color: "#DC2626", margin: "10px 0 0" }}>{error}</p>}
      {ok && <p style={{ fontSize: 12.5, color: "#16A34A", margin: "10px 0 0" }}>{ok}</p>}
    </div>
  );
}

type Props = {
  initial: BillingEntitlement;
  countryCode?: string;
  customerEmail?: string | null;
};

export default function BillingClient({
  initial,
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
    ? new Date(entitlement.period_end).toLocaleDateString(undefined, {
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
    if (!confirm("Cancel at the end of the current billing period?")) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/billing/cancel", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Could not cancel");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  function tierCta(tier: Tier) {
    const current = plan === tier.id && isPaid;
    if (current) {
      return (
        <div
          style={{
            textAlign: "center",
            fontSize: 13,
            color: tier.highlight ? "rgba(255,255,255,0.45)" : "#aaa",
            padding: "10px",
            border: tier.highlight ? "1px solid rgba(255,255,255,0.12)" : "1px solid #F0F0F0",
            borderRadius: 8,
          }}
        >
          Current plan
        </div>
      );
    }
    const rank = { starter: 0, pro: 1, advanced: 2 } as const;
    if (isPaid && rank[plan] > rank[tier.id]) {
      return (
        <div
          style={{
            textAlign: "center",
            fontSize: 13,
            color: tier.highlight ? "rgba(255,255,255,0.45)" : "#aaa",
            padding: "10px",
            border: tier.highlight ? "1px solid rgba(255,255,255,0.12)" : "1px solid #F0F0F0",
            borderRadius: 8,
          }}
        >
          Included in {plan === "advanced" ? "Advanced" : "Pro"}
        </div>
      );
    }
    return (
      <Button
        onClick={() => subscribe(tier)}
        variant={tier.highlight ? "secondary" : "primary-dark"}
        disabled={busy || !!configError || !paddle || loadingPrices}
        style={{ width: "100%" }}
      >
        {busy ? "Opening…" : `Subscribe to ${tier.name}`}
      </Button>
    );
  }

  function TierCard({ tier }: { tier: Tier }) {
    const priceId = tier.priceId[interval];
    const formatted = prices[priceId];
    const priceLabel = loadingPrices ? "…" : formatted ?? "—";
    return (
      <div
        style={{
          background: tier.highlight ? "#111" : "#fff",
          border: tier.highlight ? "none" : "1px solid #E8E8E8",
          borderRadius: 12,
          padding: "28px 24px",
          display: "flex",
          flexDirection: "column",
          boxShadow: tier.highlight
            ? "0 4px 24px rgba(0,0,0,0.16), 0 1px 4px rgba(0,0,0,0.08)"
            : "0 1px 4px rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ marginBottom: 20 }}>
          <p
            style={{
              fontSize: 12,
              color: tier.highlight ? "rgba(255,255,255,0.5)" : "#888",
              margin: "0 0 12px",
              letterSpacing: "0.01em",
            }}
          >
            {tier.name}
          </p>
          <p
            style={{
              fontSize: 32,
              fontWeight: 400,
              letterSpacing: "-0.03em",
              color: tier.highlight ? "#fff" : "#111",
              margin: "0 0 4px",
              fontVariantNumeric: "tabular-nums",
              minHeight: 40,
            }}
          >
            {priceLabel}
            <span
              style={{
                fontSize: 14,
                fontWeight: 400,
                color: tier.highlight ? "rgba(255,255,255,0.45)" : "#aaa",
                marginLeft: 4,
              }}
            >
              / user / {interval === "month" ? "mo" : "yr"}
            </span>
          </p>
          <p
            style={{
              fontSize: 13,
              color: tier.highlight ? "rgba(255,255,255,0.5)" : "#bbb",
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {tier.description}
          </p>
        </div>

        <div
          style={{
            height: 1,
            background: tier.highlight ? "rgba(255,255,255,0.1)" : "#F0F0F0",
            marginBottom: 20,
          }}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 28, flex: 1 }}>
          {tier.features.map((f) => (
            <div key={f} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: tier.highlight ? "rgba(255,255,255,0.4)" : "#22c55e", fontSize: 13 }}>
                ✓
              </span>
              <span
                style={{
                  fontSize: 13,
                  color: tier.highlight ? "rgba(255,255,255,0.75)" : "#555",
                }}
              >
                {f}
              </span>
            </div>
          ))}
        </div>

        {tierCta(tier)}
      </div>
    );
  }

  return (
    <DashboardShell>
      <style>{`
        .billing-wrap { padding: 56px 48px 80px; }
        .billing-plan-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 28px; gap: 16px; }
        .billing-usage-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
        .billing-plans-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 48px; }
        @media (max-width: 960px) {
          .billing-plans-grid { grid-template-columns: 1fr; }
        }
        .billing-plans-mobile { display: none; margin-bottom: 48px; }
        @media (max-width: 768px) {
          .billing-wrap { padding: 28px 20px 64px; }
          .billing-plan-header { flex-direction: column; align-items: stretch; }
          .billing-usage-grid { grid-template-columns: 1fr; }
          .billing-plans-grid { display: none; }
          .billing-plans-mobile { display: block; }
          .payment-input { font-size: 16px !important; }
        }
      `}</style>

      <main style={{ flex: 1, overflowY: "auto", background: "#FAFAFA" }}>
        <PageFadeIn className="billing-wrap" style={{ maxWidth: 1080, margin: "0 auto" }}>
          <div style={{ marginBottom: 48 }}>
            <h1
              style={
                {
                  fontSize: 32,
                  fontWeight: 400,
                  letterSpacing: "-0.025em",
                  color: "#111",
                  lineHeight: 1.1,
                  margin: 0,
                  textWrap: "balance",
                } as React.CSSProperties
              }
            >
              Billing
            </h1>
          </div>

          {(welcomeTrial || !isPaid) && !gifted && (
            <div
              className="notice notice-warning"
              style={{ marginBottom: 20 }}
              role="status"
            >
              <strong style={{ fontWeight: 400 }}>
                {welcomeTrial ? "Welcome to Athena. " : ""}
              </strong>
              Every plan includes a <strong style={{ fontWeight: 400 }}>7-day free trial</strong>.
              Start a trial to connect Notion, Tally, and other sources, and to upload files.
              There is no free plan — pick Starter, Pro, or Advanced below.
            </div>
          )}

          <div
            style={{
              background: "#fff",
              border: "1px solid #E8E8E8",
              borderRadius: 12,
              padding: "28px 32px",
              marginBottom: 24,
              boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
            }}
          >
            <div className="billing-plan-header">
              <div>
                <p
                  style={{
                    fontSize: 22,
                    fontWeight: 400,
                    letterSpacing: "-0.02em",
                    color: "#111",
                    margin: 0,
                  }}
                >
                  {entitlement.plan_name}
                  {!isPaid ? " · Choose a plan to start" : entitlement.status === "trialing" ? " · Trial" : ""}
                  {isPaid && entitlement.source === "promo" ? " · Promo" : ""}
                </p>
                {periodLabel && (
                  <p style={{ fontSize: 13, color: "#888", margin: "6px 0 0" }}>
                    {entitlement.status === "canceled"
                      ? `Access until ${periodLabel}`
                      : entitlement.source === "promo"
                        ? `Promo ends ${periodLabel}`
                        : `Renews ${periodLabel}`}
                  </p>
                )}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {isPaid && entitlement.source === "paddle" && entitlement.status !== "canceled" && (
                  <Button onClick={cancelSub} variant="secondary" disabled={busy}>
                    Cancel at period end
                  </Button>
                )}
              </div>
            </div>

            {(error || configError) && (
              <p style={{ fontSize: 13, color: "#DC2626", margin: "0 0 16px" }}>
                {configError || error}
              </p>
            )}

            <div className="billing-usage-grid">
              <UsageBar label="Document chunks" used={entitlement.chunks} max={limits.chunks} />
              <UsageBar label="Team members" used={entitlement.members} max={limits.seats} />
              <UsageBar label="Uploaded files" used={entitlement.files} max={limits.upload_files} />
              <UsageBar
                label="Data sources"
                used={entitlement.source_count}
                max={limits.source_types}
              />
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

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              marginBottom: 20,
              flexWrap: "wrap",
            }}
          >
            <h2
              style={
                {
                  fontSize: 16,
                  fontWeight: 400,
                  letterSpacing: "-0.02em",
                  color: "#111",
                  margin: 0,
                  textWrap: "balance",
                } as React.CSSProperties
              }
            >
              Plans
            </h2>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: 4,
                borderRadius: 9999,
                border: "1px solid #E8E8E8",
                background: "#fff",
              }}
              role="group"
              aria-label="Billing interval"
            >
              {(
                [
                  { id: "month", label: "Monthly" },
                  { id: "year", label: "Yearly" },
                ] as const
              ).map((opt) => {
                const active = interval === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setInterval(opt.id)}
                    style={{
                      height: 32,
                      padding: "0 14px",
                      borderRadius: 9999,
                      border: "none",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 400,
                      background: active ? "#111" : "transparent",
                      color: active ? "#fff" : "#888",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="billing-plans-mobile">
            <div
              style={{
                display: "flex",
                background: "#F0F0F0",
                borderRadius: 10,
                padding: 3,
                marginBottom: 16,
              }}
            >
              {TIERS.map((tier) => (
                <button
                  key={tier.id}
                  type="button"
                  onClick={() => setActiveTab(tier.id)}
                  style={{
                    flex: 1,
                    padding: "9px 0",
                    borderRadius: 8,
                    border: "none",
                    fontSize: 14,
                    fontWeight: 400,
                    cursor: "pointer",
                    background: activeTab === tier.id ? "#fff" : "transparent",
                    color: activeTab === tier.id ? "#111" : "#888",
                    boxShadow: activeTab === tier.id ? "0 1px 4px rgba(0,0,0,0.1)" : "none",
                  }}
                >
                  {tier.name}
                </button>
              ))}
            </div>
            {TIERS.filter((t) => t.id === activeTab).map((tier) => (
              <TierCard key={tier.id} tier={tier} />
            ))}
          </div>

          <div className="billing-plans-grid">
            {TIERS.map((tier) => (
              <TierCard key={tier.id} tier={tier} />
            ))}
          </div>

          <h2
            style={
              {
                fontSize: 16,
                fontWeight: 400,
                letterSpacing: "-0.02em",
                color: "#111",
                marginBottom: 20,
                textWrap: "balance",
              } as React.CSSProperties
            }
          >
            Billing history
          </h2>
          <div
            style={{
              background: "#fff",
              border: "1px solid #E8E8E8",
              borderRadius: 12,
              overflow: "hidden",
              boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
            }}
          >
            <div style={{ padding: "32px 24px", textAlign: "center" }}>
              <p style={{ fontSize: 13.5, color: "#999", margin: 0 }}>
                {isPaid && entitlement.source === "paddle"
                  ? "Invoices are available in the Paddle customer portal after each successful charge."
                  : "No billing history yet. Subscribe above to start — invoices appear after each charge."}
              </p>
            </div>
          </div>
        </PageFadeIn>
      </main>
      <Toast message={toast} tone="success" onDismiss={() => setToast(null)} />
    </DashboardShell>
  );
}
