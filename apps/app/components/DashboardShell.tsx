"use client";

import { useOrganization } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  CaretRight,
  ChatTeardropText,
  DotsThree,
  FileText,
  House,
  SignOut,
  Users,
  X,
  type Icon,
} from "@phosphor-icons/react";
import SideNav, { ADMIN_ITEMS, isNavActive, MEMBER_SETTINGS_ITEM, SignOutDialog } from "./SideNav";
import { OrgLogo } from "./athena/Orb";

const TABS: { label: string; href: string; icon: Icon; admin?: boolean }[] = [
  { label: "Overview", href: "/dashboard", icon: House },
  { label: "Chat", href: "/chat", icon: ChatTeardropText },
  { label: "Files", href: "/admin/files", icon: FileText, admin: true },
  { label: "Team", href: "/admin/staff", icon: Users, admin: true },
];

const MORE_HREFS = ["/admin/connections", "/admin/analytics", "/admin/settings", "/admin/billing"];

function MoreSheet({ open, isAdmin, onClose, onSignOut }: { open: boolean; isAdmin: boolean; onClose: () => void; onSignOut: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const items = isAdmin ? ADMIN_ITEMS.filter((i) => MORE_HREFS.includes(i.href)) : [MEMBER_SETTINGS_ITEM];
  return (
    <div className="a-scrim sheet" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="a-sheet" role="dialog" aria-modal="true" aria-label="More">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid var(--a-line)" }}>
          <span className="a-kicker">{isAdmin ? "Admin" : "Account"}</span>
          <button type="button" className="a-icon-btn sm bare" aria-label="Close" onClick={onClose}>
            <X size={16} color="var(--a-ink)" />
          </button>
        </div>
        {items.map((item) => {
          const I = item.icon;
          return (
            <Link key={item.href} href={item.href} className="a-sheet-row" onClick={onClose}>
              <I size={18} />
              <span style={{ flex: 1 }}>{item.label}</span>
              <CaretRight size={14} color="var(--a-faint)" />
            </Link>
          );
        })}
        <button type="button" className="a-sheet-row" style={{ color: "var(--a-danger)" }} onClick={onSignOut}>
          <SignOut size={18} />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
}

/**
 * App frame for every signed-in page: 248px sidebar on desktop, top bar +
 * five-tab bar with a More sheet below 768px. Pages render inside `.a-main`
 * and own their scroll area (see `AppPage`).
 */
export default function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { organization, membership } = useOrganization();
  const isAdmin = membership?.role === "org:admin";
  const [moreOpen, setMoreOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);

  const tabs = TABS.filter((t) => !t.admin || isAdmin);
  const moreActive = MORE_HREFS.some((h) => pathname.startsWith(h));

  return (
    <div className="a-root a-app">
      <SideNav />

      <header className="a-m-top">
        <Link href="/dashboard" className="a-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/athena-knot.svg" alt="" />
          Athena
        </Link>
        <div className="org">
          <span>{organization?.name ?? ""}</span>
          <span style={{ display: "flex", borderRadius: 8, overflow: "hidden" }}>
            <OrgLogo src={organization?.hasImage ? organization.imageUrl : null} seed={organization?.id ?? "org"} size={28} />
          </span>
        </div>
      </header>

      <main className="a-main">{children}</main>

      <nav className="a-tabbar" aria-label="Primary" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, 1fr)` }}>
        {tabs.map((t) => {
          const active = isNavActive(pathname, t.href);
          const I = t.icon;
          return (
            <Link key={t.href} href={t.href} className="a-tab" aria-current={active ? "page" : undefined}>
              <span className="pill"><I size={18} weight={active ? "fill" : "regular"} /></span>
              {t.label}
            </Link>
          );
        })}
        <button type="button" className="a-tab" aria-current={moreActive ? "page" : undefined} aria-haspopup="dialog" onClick={() => setMoreOpen(true)}>
          <span className="pill"><DotsThree size={18} weight={moreActive ? "bold" : "regular"} /></span>
          More
        </button>
      </nav>

      <MoreSheet
        open={moreOpen}
        isAdmin={isAdmin}
        onClose={() => setMoreOpen(false)}
        onSignOut={() => { setMoreOpen(false); setSignOutOpen(true); }}
      />
      <SignOutDialog open={signOutOpen} onClose={() => setSignOutOpen(false)} />
    </div>
  );
}

/** Standard scrollable page body: centred 1080px column. */
export function AppPage({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div className="a-scroll">
      <div className={`a-wrap${narrow ? " narrow" : ""}`}>{children}</div>
    </div>
  );
}
