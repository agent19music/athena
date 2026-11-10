"use client";

import { EnvelopeSimple } from "@phosphor-icons/react";
import { Avatar } from "../athena/Orb";

interface StaffCardProps {
  answer: string;
  staffName?: string;
  staffEmail?: string;
  staffDomain?: string;
  staffTitle?: string;
  staffDepartment?: string;
  /** Optional photo; falls back to the seeded orb. */
  staffImageUrl?: string | null;
}

export default function StaffCard({
  answer,
  staffName,
  staffEmail,
  staffDomain,
  staffTitle,
  staffDepartment,
  staffImageUrl,
}: StaffCardProps) {
  const firstName = staffName?.trim().split(/\s+/)[0];
  const meta = staffTitle ? `${staffTitle}${staffDepartment ? ` · ${staffDepartment}` : ""}` : staffDepartment || staffDomain;

  return (
    <div className="a-ac a-ac-answer">
      <div className="a-ac-k">No matching document</div>
      <div className="a-ac-a ink" style={{ whiteSpace: "pre-wrap" }}>{answer}</div>

      {staffName && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--a-line)", flexWrap: "wrap" }}>
          <Avatar src={staffImageUrl} seed={staffEmail ?? staffName} size={36} alt={staffName} />
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: 14 }}>{staffName}</div>
            {meta && <div style={{ fontSize: 12, color: "var(--a-muted)" }}>{meta}</div>}
          </div>
          {staffEmail && (
            <a href={`mailto:${staffEmail}`} className="a-btn a-btn-secondary a-btn-sm">
              <EnvelopeSimple size={14} />
              Email {firstName}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
