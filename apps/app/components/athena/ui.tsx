import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-quiet";
type BtnSize = "sm" | "md" | "lg";

function btnClass(variant: BtnVariant, size: BtnSize, block?: boolean, extra?: string) {
  return [
    "a-btn",
    `a-btn-${variant}`,
    size === "sm" ? "a-btn-sm" : size === "lg" ? "a-btn-lg" : "",
    block ? "a-btn-block" : "",
    extra ?? "",
  ].filter(Boolean).join(" ");
}

export function Btn({
  variant = "secondary",
  size = "md",
  block,
  className,
  type = "button",
  ...rest
}: ComponentProps<"button"> & { variant?: BtnVariant; size?: BtnSize; block?: boolean }) {
  return <button type={type} className={btnClass(variant, size, block, className)} {...rest} />;
}

export function BtnLink({
  variant = "secondary",
  size = "md",
  block,
  className,
  ...rest
}: ComponentProps<typeof Link> & { variant?: BtnVariant; size?: BtnSize; block?: boolean }) {
  return <Link className={btnClass(variant, size, block, className)} {...rest} />;
}

export function IconBtn({
  sm,
  bare,
  className,
  type = "button",
  ...rest
}: ComponentProps<"button"> & { sm?: boolean; bare?: boolean; "aria-label": string }) {
  return (
    <button
      type={type}
      className={["a-icon-btn", sm ? "sm" : "", bare ? "bare" : "", className ?? ""].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export type BadgeTone = "ok" | "warn" | "err" | "ink" | "neutral";

export function Badge({ tone = "neutral", dot = true, children }: { tone?: BadgeTone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`a-badge ${tone === "neutral" ? "" : tone}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function Count({ children }: { children: ReactNode }) {
  return <span className="a-count">{children}</span>;
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="a-tag">{children}</span>;
}

export function Tile({ children, lg, style }: { children: ReactNode; lg?: boolean; style?: React.CSSProperties }) {
  return <span className={`a-tile${lg ? " lg" : ""}`} style={style}>{children}</span>;
}

export function PageHeader({ title, sub, subMobile, actions, hideActionsOnMobile }: { title: ReactNode; sub?: ReactNode; subMobile?: ReactNode; actions?: ReactNode; hideActionsOnMobile?: boolean }) {
  return (
    <div className="a-ph-head">
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        {sub && !subMobile && <p>{sub}</p>}
        {sub && subMobile && (
          <>
            <p className="a-only-d">{sub}</p>
            <p className="a-only-m">{subMobile}</p>
          </>
        )}
      </div>
      {actions && <div className={`a-ph-actions${hideActionsOnMobile ? " hide-m" : ""}`}>{actions}</div>}
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="a-sec-t">
      <h2>{children}</h2>
      {aside}
    </div>
  );
}

export function StatCard({ icon, value, label, hint }: { icon: ReactNode; value: ReactNode; label: ReactNode; hint?: ReactNode }) {
  return (
    <div className="a-card a-stat">
      <Tile>{icon}</Tile>
      <div>
        <div className="v">{value}</div>
        <div className="l">{label}</div>
        {hint && <div className="h">{hint}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children, htmlFor }: { label: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="a-field">
      <label className="a-label" htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

export function Bar({ pct, tone, thin }: { pct: number; tone?: "warn"; thin?: boolean }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div className={["a-bar", tone ?? "", thin ? "thin" : ""].filter(Boolean).join(" ")} role="progressbar" aria-valuenow={Math.round(w)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${w}%` }} />
    </div>
  );
}
