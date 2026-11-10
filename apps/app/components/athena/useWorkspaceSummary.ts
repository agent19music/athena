"use client";

import { useEffect, useState } from "react";
import type { BillingEntitlement } from "@/lib/billing";

/**
 * Lightweight, cached read of /api/billing/entitlement for the app shell:
 * plan label and nav counts (files, sources, members). One request per
 * page load, shared by every component that asks.
 */
export type WorkspaceSummary = {
  planName: string;
  status: string;
  files: number;
  sources: number;
  members: number;
};

let cache: WorkspaceSummary | null = null;
let inflight: Promise<WorkspaceSummary | null> | null = null;

function load(): Promise<WorkspaceSummary | null> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/api/billing/entitlement", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return null;
        const e = (await r.json()) as Partial<BillingEntitlement>;
        cache = {
          planName: e.plan_name ?? "Starter",
          status: e.status ?? "active",
          files: e.files ?? 0,
          sources: e.source_count ?? 0,
          members: e.members ?? 0,
        };
        return cache;
      })
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useWorkspaceSummary(enabled = true): WorkspaceSummary | null {
  const [data, setData] = useState<WorkspaceSummary | null>(cache);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    load().then((d) => {
      if (alive && d) setData(d);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return data;
}

export function planLine(role: "admin" | "member", s: WorkspaceSummary | null): string {
  const r = role === "admin" ? "Admin" : "Member";
  if (!s) return r;
  const st = s.status.toLowerCase();
  const suffix = st === "trialing" || st === "trial" ? " trial" : st === "past_due" ? " · past due" : st === "canceled" || st === "cancelled" ? " · cancelled" : "";
  return `${r} · ${s.planName}${suffix}`;
}
