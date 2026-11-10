import { useId } from "react";

/**
 * Seeded radial-gradient orb used wherever a person or org has no photo.
 * Flat SVG, no blur. Palettes and stop positions follow the Doop canon
 * (App · 00 · Components). Same seed → same orb, everywhere.
 */
const PALETTES = [
  ["#F2E9FF", "#D4B8F3", "#A079D5", "#7050A6", "#403266"], // purple
  ["#E5F3FF", "#AED7FC", "#589DE8", "#3266BA", "#243B75"], // blue
  ["#E1FAF2", "#A0DFD0", "#53B8A3", "#2A817C", "#22505A"], // teal
  ["#F3F5E8", "#D5DDB4", "#A3B26A", "#5E6E2C", "#2F3A12"], // olive
  ["#FFF3E6", "#F7D2A6", "#E1A15E", "#A8652A", "#5E3A1C"], // amber
] as const;

const STOPS = [0, 0.25, 0.55, 0.82, 1];

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function Orb({ seed, size = 28, className, style }: { seed: string; size?: number; className?: string; style?: React.CSSProperties }) {
  const rid = useId().replace(/:/g, "");
  const h = hash(seed || "athena");
  const palette = PALETTES[h % PALETTES.length];
  const cx = 33 + ((h >>> 4) % 6);
  const cy = 24 + ((h >>> 8) % 9);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      className={className}
      style={{ flexShrink: 0, display: "block", borderRadius: "50%", ...style }}
    >
      <defs>
        <radialGradient id={`orb-${rid}`} gradientUnits="userSpaceOnUse" cx={cx} cy={cy} r={82}>
          {palette.map((c, i) => (
            <stop key={i} offset={STOPS[i]} stopColor={c} />
          ))}
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="50" fill={`url(#orb-${rid})`} />
    </svg>
  );
}

/** Photo when one exists, otherwise the seeded orb. Never initials. */
export function Avatar({ src, seed, size = 28, alt = "" }: { src?: string | null; seed: string; size?: number; alt?: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} width={size} height={size} className="a-avatar" style={{ width: size, height: size }} />;
  }
  return <Orb seed={seed} size={size} />;
}

/** Org logo (24px rounded square) or an orb fallback. */
export function OrgLogo({ src, seed, size = 24 }: { src?: string | null; seed: string; size?: number }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className="a-org-logo" style={{ width: size, height: size }} />;
  }
  return <Orb seed={seed} size={size} />;
}
