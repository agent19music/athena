"use client";

import { useRef, type KeyboardEvent } from "react";
import type { ThemePref } from "@/lib/theme";
import { useTheme } from "./ThemeProvider";

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System default" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Three-way Appearance control (Doop 6IJAlE08J9 / zCEA-HXE4O). */
export function ThemeControl() {
  const { pref, setPref } = useTheme();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = OPTIONS.findIndex((o) => o.value === pref);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % OPTIONS.length;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + OPTIONS.length) % OPTIONS.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = OPTIONS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setPref(OPTIONS[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div className="a-theme-seg" role="radiogroup" aria-label="Theme" onKeyDown={onKeyDown}>
      {OPTIONS.map((o, i) => {
        const on = pref === o.value;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={on ? "on" : undefined}
            onClick={() => setPref(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
