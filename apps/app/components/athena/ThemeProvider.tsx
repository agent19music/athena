"use client";

import { useUser } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import {
  isLightOnlyPath,
  isThemePref,
  THEME_COLOR,
  THEME_COOKIE,
  THEME_METADATA_KEY,
  THEME_RESOLVED_COOKIE,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePref,
} from "@/lib/theme";

type ThemeContextValue = {
  /** The stored per-user preference. */
  pref: ThemePref;
  /** The sheet currently applied to <html>. */
  resolved: ResolvedTheme;
  setPref: (pref: ThemePref) => void;
};

const ThemeContext = createContext<ThemeContextValue>({ pref: "system", resolved: "light", setPref: () => {} });

const DARK_QUERY = "(prefers-color-scheme: dark)";

function readLocalPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePref(v)) return v;
  } catch {}
  const m = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]+)`));
  const c = m ? decodeURIComponent(m[1]) : null;
  return isThemePref(c) ? c : "system";
}

function writeLocalPref(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {}
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${THEME_COOKIE}=${pref}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

function resolve(pref: ThemePref, pathname: string): ResolvedTheme {
  if (isLightOnlyPath(pathname)) return "light";
  if (pref === "light" || pref === "dark") return pref;
  return window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

function apply(pref: ThemePref, pathname: string) {
  const el = document.documentElement;
  const resolved = resolve(pref, pathname);
  if (el.getAttribute("data-theme") !== resolved) el.setAttribute("data-theme", resolved);
  if (el.getAttribute("data-theme-pref") !== pref) el.setAttribute("data-theme-pref", pref);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", THEME_COLOR[resolved]));
  if (!isLightOnlyPath(pathname)) {
    document.cookie = `${THEME_RESOLVED_COOKIE}=${resolved}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }
}

// <html> attributes are the single source of truth, so every consumer sees
// the value the pre-paint script (or the last apply) wrote.
function subscribe(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-theme-pref"] });
  return () => obs.disconnect();
}
const getPref = (): ThemePref => {
  const v = document.documentElement.getAttribute("data-theme-pref");
  return isThemePref(v) ? v : "system";
};
const getResolved = (): ResolvedTheme => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
const serverPref = (): ThemePref => "system";
const serverResolved = (): ResolvedTheme => "light";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const pref = useSyncExternalStore(subscribe, getPref, serverPref);
  const resolved = useSyncExternalStore(subscribe, getResolved, serverResolved);
  const { isLoaded, user } = useUser();
  const pathRef = useRef(pathname);

  // Re-apply on navigation (light-only legacy routes) and on first mount.
  useEffect(() => {
    pathRef.current = pathname;
    apply(readLocalPref(), pathname);
  }, [pathname]);

  // System preference: follow device changes live.
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia?.(DARK_QUERY);
    if (!mq) return;
    const onChange = () => apply("system", pathRef.current);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  // Another tab changed the preference.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) apply(readLocalPref(), pathRef.current);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Per-user sync with Clerk: the account's saved choice wins on load, so it
  // follows the person across devices. A device-only choice made before the
  // account had one is uploaded.
  const syncedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isLoaded || !user || syncedFor.current === user.id) return;
    syncedFor.current = user.id;
    const remote = user.unsafeMetadata?.[THEME_METADATA_KEY];
    const local = readLocalPref();
    if (isThemePref(remote)) {
      if (remote !== local) {
        writeLocalPref(remote);
        apply(remote, pathRef.current);
      }
    } else if (local !== "system") {
      user.update({ unsafeMetadata: { ...user.unsafeMetadata, [THEME_METADATA_KEY]: local } }).catch(() => {});
    }
  }, [isLoaded, user]);

  const setPref = useCallback(
    (next: ThemePref) => {
      writeLocalPref(next);
      apply(next, pathRef.current);
      if (user && user.unsafeMetadata?.[THEME_METADATA_KEY] !== next) {
        user.update({ unsafeMetadata: { ...user.unsafeMetadata, [THEME_METADATA_KEY]: next } }).catch(() => {});
      }
    },
    [user],
  );

  const value = useMemo(() => ({ pref, resolved, setPref }), [pref, resolved, setPref]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

const noopSubscribe = () => () => {};

/**
 * The applied sheet, but during SSR and hydration it returns `serverHint`
 * (from the request cookies) instead of assuming light, so server-rendered
 * pieces such as Clerk's <SignIn /> don't flash the wrong theme.
 */
export function useResolvedTheme(serverHint?: ResolvedTheme): ResolvedTheme {
  const { resolved } = useTheme();
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return hydrated || !serverHint ? resolved : serverHint;
}
