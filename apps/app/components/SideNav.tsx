"use client";

import { useClerk, useOrganization, useOrganizationList, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  CaretUpDown,
  ChartBar,
  ChatTeardropText,
  Check,
  CreditCard,
  FileText,
  Gear,
  House,
  Plugs,
  SignOut,
  Users,
  type IconProps,
} from "@phosphor-icons/react";
import { Avatar, OrgLogo } from "@/components/athena/Orb";
import { ConfirmDialog } from "@/components/athena/ConfirmDialog";
import { planLine, useWorkspaceSummary, type WorkspaceSummary } from "@/components/athena/useWorkspaceSummary";

type NavItem = {
  label: string;
  href: string;
  icon: ComponentType<IconProps>;
  count?: (s: WorkspaceSummary | null) => number | undefined;
};

export const MAIN_ITEMS: NavItem[] = [
  { label: "Overview", href: "/dashboard", icon: House },
  { label: "Chat", href: "/chat", icon: ChatTeardropText },
];

export const ADMIN_ITEMS: NavItem[] = [
  { label: "Files", href: "/admin/files", icon: FileText, count: (s) => s?.files },
  { label: "Connections", href: "/admin/connections", icon: Plugs, count: (s) => s?.sources },
  { label: "Analytics", href: "/admin/analytics", icon: ChartBar },
  { label: "Team", href: "/admin/staff", icon: Users, count: (s) => s?.members },
  { label: "Settings", href: "/admin/settings", icon: Gear },
  { label: "Billing", href: "/admin/billing", icon: CreditCard },
];

export function isNavActive(pathname: string, href: string) {
  return href === "/dashboard" ? pathname === href : pathname.startsWith(href);
}

/** Sign-out confirmation shared by the sidebar and the mobile More sheet. */
export function SignOutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { signOut } = useClerk();
  const { organization } = useOrganization();
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      open={open}
      icon={<SignOut size={18} />}
      title="Sign out of Athena?"
      body={`You'll need to sign in again to ask questions or manage ${organization?.name ?? "your organisation"}.`}
      confirmLabel="Sign out"
      busy={busy}
      onCancel={onClose}
      onConfirm={async () => {
        setBusy(true);
        try {
          await signOut({ redirectUrl: "/" });
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

function OrgCard({ summary }: { summary: WorkspaceSummary | null }) {
  const { organization, membership } = useOrganization();
  const isAdmin = membership?.role === "org:admin";
  const { userMemberships, setActive, isLoaded } = useOrganizationList({ userMemberships: true });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const orgs = isLoaded ? userMemberships?.data ?? [] : [];
  const canSwitch = orgs.length > 1;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const name = organization?.name ?? "Organisation";
  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        className="a-org"
        style={{ width: "100%", cursor: canSwitch ? "pointer" : "default", textAlign: "left" }}
        onClick={() => canSwitch && setOpen((o) => !o)}
        aria-haspopup={canSwitch ? "listbox" : undefined}
        aria-expanded={canSwitch ? open : undefined}
      >
        <OrgLogo src={organization?.hasImage ? organization.imageUrl : null} seed={organization?.id ?? name} />
        <div className="t">
          <div className="n">{name}</div>
          <div className="s">{planLine(isAdmin ? "admin" : "member", summary)}</div>
        </div>
        <CaretUpDown size={14} color="var(--a-muted)" />
      </button>
      {open && (
        <div className="a-org-switch" role="listbox" style={{ marginTop: -14 }}>
          {orgs.map((m) => {
            const current = m.organization.id === organization?.id;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={current}
                aria-current={current}
                onClick={async () => {
                  setOpen(false);
                  if (!current && setActive) {
                    await setActive({ organization: m.organization.id });
                    window.location.assign("/dashboard");
                  }
                }}
              >
                <OrgLogo src={m.organization.hasImage ? m.organization.imageUrl : null} seed={m.organization.id} />
                <span className="a-ellipsis" style={{ flex: 1 }}>{m.organization.name}</span>
                {current && <Check size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NavLink({ item, active, count }: { item: NavItem; active: boolean; count?: number }) {
  const Icon = item.icon;
  return (
    <Link href={item.href} className="a-nl" aria-current={active ? "page" : undefined}>
      <Icon size={16} weight={active ? "fill" : "regular"} />
      <span className="grow">{item.label}</span>
      {typeof count === "number" && count > 0 && <span className="a-count">{count.toLocaleString()}</span>}
    </Link>
  );
}

export default function SideNav() {
  const pathname = usePathname();
  const { membership } = useOrganization();
  const { user } = useUser();
  const isAdmin = membership?.role === "org:admin";
  const summary = useWorkspaceSummary(isAdmin);
  const [signOutOpen, setSignOutOpen] = useState(false);

  const fullName = user?.fullName || [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "Account";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";

  return (
    <aside className="a-side" aria-label="Primary">
      <Link href="/dashboard" className="a-brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/athena-knot.svg" alt="" />
        Athena
      </Link>

      <OrgCard summary={summary} />

      <div className="a-group">Workspace</div>
      {MAIN_ITEMS.map((item) => (
        <NavLink key={item.href} item={item} active={isNavActive(pathname, item.href)} />
      ))}

      {isAdmin && (
        <>
          <div style={{ height: 14, flexShrink: 0 }} />
          <div className="a-group">Admin</div>
          {ADMIN_ITEMS.map((item) => (
            <NavLink key={item.href} item={item} active={isNavActive(pathname, item.href)} count={item.count?.(summary)} />
          ))}
        </>
      )}
      <div style={{ height: 14, flexShrink: 0 }} />

      <div className="a-acct">
        <Avatar src={user?.hasImage ? user.imageUrl : null} seed={user?.id ?? email} size={28} alt={fullName} />
        <div className="t">
          <div className="n">{fullName}</div>
          <div className="e">{email}</div>
        </div>
        <button type="button" className="a-icon-btn sm bare" aria-label="Sign out" onClick={() => setSignOutOpen(true)}>
          <SignOut size={16} color="var(--a-danger)" />
        </button>
      </div>

      <SignOutDialog open={signOutOpen} onClose={() => setSignOutOpen(false)} />
    </aside>
  );
}
