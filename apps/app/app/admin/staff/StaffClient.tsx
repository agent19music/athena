"use client";

import { useEffect, useMemo, useState } from "react";
import { useOrganization } from "@clerk/nextjs";
import { CaretUpDown, PaperPlaneRight, UsersThree } from "@phosphor-icons/react";
import { Avatar } from "../../../components/athena/Orb";
import { Badge, Tile } from "../../../components/athena/ui";
import { Toast } from "../../../components/Toast";

const INVITE_COOLDOWN_SECONDS = 59;

// Counts down once per second after an invite email goes out, so the
// send/resend button can't be spammed into re-sending the same email.
function useCooldown() {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (remaining <= 0) return;
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining]);

  return [remaining, () => setRemaining(INVITE_COOLDOWN_SECONDS)] as const;
}

type Member = {
  id: string;
  role: string;
  email: string;
  name: string;
  joinedAt: string;
  imageUrl?: string | null;
};

type PendingInvitation = {
  id: string;
  email: string;
  role: string;
  invitedAt: string;
};

// Free mail providers never become the "company domain" suffix.
const FREE_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com", "gmx.com",
]);

/** Most common non-free email domain among current members, if any. */
function companyDomain(members: Member[]): string | null {
  const counts = new Map<string, number>();
  for (const m of members) {
    const d = m.email.split("@")[1]?.toLowerCase();
    if (!d || FREE_DOMAINS.has(d)) continue;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [d, c] of counts) if (c > n) { best = d; n = c; }
  return best;
}

function InviteForm({
  currentUserEmails,
  domain,
  onSent,
}: {
  currentUserEmails: string[];
  domain: string | null;
  onSent: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [useDomain, setUseDomain] = useState(true);
  const [role, setRole] = useState("org:member");
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState("");
  const [cooldown, startCooldown] = useCooldown();

  const suffixed = !!domain && useDomain;
  const fullEmail = suffixed ? `${email.trim().replace(/@.*$/, "")}@${domain}` : email.trim();
  const isSelf = currentUserEmails.includes(fullEmail.toLowerCase());

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || isSelf) return;
    setState("loading");
    try {
      const res = await fetch("/api/admin/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: fullEmail, role }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error ?? "Failed to send");
        setState("error");
      } else {
        setState("idle");
        setEmail("");
        onSent(data.email);
        startCooldown();
      }
    } catch {
      setMessage("Could not reach server");
      setState("error");
    }
  }

  return (
    <form onSubmit={send}>
      <div className="a-invite-grid">
        <div className="a-field">
          <label className="a-label" htmlFor="invite-email">Email</label>
          <div className={`a-input${state === "error" || isSelf ? " invalid" : ""}`} style={suffixed ? { paddingRight: 6, gap: 6 } : undefined}>
            <input
              id="invite-email"
              type={suffixed ? "text" : "email"}
              inputMode="email"
              autoComplete="off"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (state === "error") setState("idle"); }}
              placeholder={suffixed ? "jane" : "jane@company.com"}
              required
            />
            {suffixed && <span className="a-input-suffix">@{domain}</span>}
          </div>
          {domain && (
            <button type="button" className="a-text-btn" onClick={() => setUseDomain((u) => !u)}>
              {useDomain ? "Use another email" : `Use @${domain}`}
            </button>
          )}
        </div>
        <div className="a-field">
          <label className="a-label" htmlFor="invite-role">Role</label>
          <div className="a-input" style={{ position: "relative" }}>
            <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="org:member">Member</option>
              <option value="org:admin">Admin</option>
            </select>
            <CaretUpDown size={14} color="var(--a-muted)" style={{ pointerEvents: "none", flexShrink: 0 }} />
          </div>
        </div>
        <div className="a-field">
          <span className="a-label a-only-d" style={{ visibility: "hidden" }} aria-hidden="true">Invite</span>
          <button type="submit" className="a-btn a-btn-primary" style={{ height: 40 }} disabled={!email.trim() || isSelf || state === "loading" || cooldown > 0}>
            <PaperPlaneRight size={14} />
            {state === "loading" ? "Sending…" : cooldown > 0 ? `Send again in ${cooldown}s` : "Send invite"}
          </button>
        </div>
      </div>
      {isSelf && <p style={{ fontSize: 12, color: "var(--a-danger)", marginTop: 8 }}>That&apos;s your own email address.</p>}
      {state === "error" && <p style={{ fontSize: 12, color: "var(--a-danger)", marginTop: 8 }}>{message}</p>}
    </form>
  );
}

function ResendButton({
  invitation,
  onSent,
}: {
  invitation: PendingInvitation;
  onSent: (email: string) => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");
  const [cooldown, startCooldown] = useCooldown();

  async function resend() {
    setState("loading");
    setError("");
    try {
      const res = await fetch("/api/admin/invite/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invitationId: invitation.id,
          email: invitation.email,
          role: invitation.role,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to resend");
        setState("error");
        return;
      }
      setState("idle");
      onSent(data.email);
      startCooldown();
    } catch {
      setError("Could not reach server");
      setState("error");
    }
  }

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      {cooldown > 0 ? (
        <span style={{ fontSize: 12, color: "var(--a-muted)" }}>Sent · resend in {cooldown}s</span>
      ) : (
        <button type="button" className="a-btn a-btn-secondary a-btn-sm" onClick={resend} disabled={state === "loading"}>
          {state === "loading" ? "Resending…" : "Resend invite"}
        </button>
      )}
      {state === "error" && <p style={{ fontSize: 12, color: "var(--a-danger)" }}>{error}</p>}
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  return role === "org:admin" ? <Badge tone="ink" dot={false}>Admin</Badge> : <Badge dot={false}>Member</Badge>;
}

function PendingBadge() {
  return <Badge tone="warn">Pending</Badge>;
}

const STAFF_POLL_MS = 4000;

export default function StaffClient({
  members: initialMembers,
  pendingInvitations: initialPendingInvitations,
  currentUserEmails,
}: {
  members: Member[];
  pendingInvitations: PendingInvitation[];
  currentUserEmails: string[];
}) {
  const { organization } = useOrganization();
  const [toast, setToast] = useState<string | null>(null);
  const [members, setMembers] = useState(initialMembers);
  const [pendingInvitations, setPendingInvitations] = useState(initialPendingInvitations);

  async function refreshStaff() {
    try {
      const res = await fetch("/api/admin/staff", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setMembers(data.members ?? []);
      setPendingInvitations(data.pendingInvitations ?? []);
    } catch {
      /* keep showing the current list — next poll or action will retry */
    }
  }

  // While an invite is outstanding, poll so it flips from "Pending" to a
  // member the moment it's accepted — no manual refresh needed.
  useEffect(() => {
    if (pendingInvitations.length === 0) return;
    const id = setInterval(refreshStaff, STAFF_POLL_MS);
    return () => clearInterval(id);
  }, [pendingInvitations.length]);

  function announceSent(email: string) {
    setToast(`Invitation sent to ${email}. If it doesn't show up, ask them to check the Promotions tab.`);
    refreshStaff();
  }

  const domain = useMemo(() => companyDomain(members), [members]);
  const isMe = (m: Member) => currentUserEmails.includes(m.email.toLowerCase());

  return (
    <>
      <div className="a-card a-card-pad a-invite" style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 16, marginBottom: 4 }}>Invite a teammate</div>
        <div style={{ fontSize: 13, color: "var(--a-muted)", marginBottom: 16 }}>
          They get an email invite and join {organization?.name ?? "your organisation"} when they sign in.
        </div>
        <InviteForm currentUserEmails={currentUserEmails} domain={domain} onSent={announceSent} />
      </div>

      {pendingInvitations.length > 0 && (
        <>
          <div className="a-sec-t">
            <h2>Pending invites <span className="a-count">{pendingInvitations.length}</span></h2>
          </div>
          <div className="a-card a-clip a-team-block">
            <table className="a-tbl a-only-d">
              <thead>
                <tr>
                  <th>Email</th>
                  <th style={{ width: 120 }}>Role</th>
                  <th style={{ width: 160 }}>Invited</th>
                  <th style={{ width: 140 }}>Status</th>
                  <th style={{ width: 180 }} />
                </tr>
              </thead>
              <tbody>
                {pendingInvitations.map((inv) => (
                  <tr key={inv.id}>
                    <td className="a-ellipsis" title={inv.email}>{inv.email}</td>
                    <td><RoleBadge role={inv.role} /></td>
                    <td className="muted">{inv.invitedAt}</td>
                    <td><PendingBadge /></td>
                    <td style={{ textAlign: "right" }}><ResendButton invitation={inv} onSent={announceSent} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="a-only-m a-divide">
              {pendingInvitations.map((inv) => (
                <div key={inv.id} style={{ padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="a-ellipsis" style={{ flex: 1, fontSize: 14 }}>{inv.email}</span>
                    <PendingBadge />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                    <span style={{ fontSize: 12, color: "var(--a-muted)", flex: 1 }}>
                      {inv.role === "org:admin" ? "Admin" : "Member"} · Invited {inv.invitedAt}
                    </span>
                    <ResendButton invitation={inv} onSent={announceSent} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="a-sec-t">
        <h2>Members <span className="a-count">{members.length}</span></h2>
      </div>
      <div className="a-card a-clip a-team-block">
        {members.length === 0 ? (
          <p style={{ padding: 20, fontSize: 14, color: "var(--a-muted)" }}>No members yet.</p>
        ) : (
          <>
            <table className="a-tbl a-only-d">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th style={{ width: 120 }}>Role</th>
                  <th style={{ width: 160 }}>Joined</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <Avatar src={m.imageUrl} seed={m.email || m.id} size={28} alt={m.name} />
                        <span className="a-ellipsis">{m.name || m.email}</span>
                        {isMe(m) && <span style={{ fontSize: 12, color: "var(--a-muted)" }}>You</span>}
                      </div>
                    </td>
                    <td className="muted a-ellipsis" title={m.email}>{m.email}</td>
                    <td><RoleBadge role={m.role} /></td>
                    <td className="muted">{m.joinedAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="a-only-m a-divide">
              {members.map((m) => (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
                  <Avatar src={m.imageUrl} seed={m.email || m.id} size={32} alt={m.name} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14 }}>{m.name || m.email}{isMe(m) && <span style={{ fontSize: 12, color: "var(--a-muted)" }}> · You</span>}</div>
                    <div className="a-ellipsis" style={{ fontSize: 12, color: "var(--a-muted)" }}>{m.email}</div>
                  </div>
                  <RoleBadge role={m.role} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="a-card a-staffdir">
        <Tile><UsersThree size={16} /></Tile>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14 }}>Staff directory</span>
            <Badge dot={false}>Coming soon</Badge>
          </div>
          <p style={{ fontSize: 13, color: "var(--a-muted)", lineHeight: 1.55, marginTop: 4 }}>
            When Athena can&apos;t find an answer in your docs, it suggests the right teammate to ask. You&apos;ll be able to edit names, roles and departments here. Until then, contact support to update the directory.
          </p>
        </div>
      </div>

      <Toast message={toast} onDismiss={() => setToast(null)} tone="success" />
    </>
  );
}
