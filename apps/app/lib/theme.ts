/**
 * Athena appearance: a per-user theme preference (system | light | dark).
 *
 * Resolution (Doop "Appearance and theme resolution", GIWcS886C0):
 *   - system (default): follow prefers-color-scheme and update live.
 *   - light / dark: keep that sheet until the user changes it.
 * The resolved sheet is written to <html data-theme="light|dark"> before
 * first paint by THEME_INIT_SCRIPT, so the wrong sheet never flashes.
 *
 * Storage: localStorage + a cookie on this device (read before paint), and
 * Clerk `unsafeMetadata.athenaTheme` so the choice follows the user across
 * devices (synced by ThemeProvider once Clerk loads).
 */

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "athena-theme";
export const THEME_COOKIE = "athena-theme";
/** Last sheet applied on this device, so server renders (e.g. Clerk on /login) can match it. */
export const THEME_RESOLVED_COOKIE = "athena-theme-resolved";
export const THEME_METADATA_KEY = "athenaTheme";

/** Legacy screens that were never designed for dark stay on the light sheet. */
export const LIGHT_ONLY_PREFIXES = ["/register", "/invite", "/migration"];

export function isThemePref(v: unknown): v is ThemePref {
  return v === "system" || v === "light" || v === "dark";
}

export function isLightOnlyPath(pathname: string) {
  return LIGHT_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Browser-chrome colour per sheet (light keeps the previous #ffffff). */
export const THEME_COLOR: Record<ResolvedTheme, string> = { light: "#F9F9FA", dark: "#202021" };

/**
 * Best server-side guess at the sheet from request cookies. An explicit Light
 * or Dark preference wins; for System it falls back to the sheet last applied
 * on this device. Returns undefined when there is no hint.
 */
export function themeFromCookies(get: (name: string) => string | undefined): ResolvedTheme | undefined {
  const pref = get(THEME_COOKIE);
  if (pref === "light" || pref === "dark") return pref;
  const last = get(THEME_RESOLVED_COOKIE);
  return last === "light" || last === "dark" ? last : undefined;
}

/**
 * Inline, render-blocking script for <head>. Keep it dependency-free and in
 * sync with the constants above.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)},p=null;try{p=localStorage.getItem(k)}catch(e){}if(!p){var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]+)/);p=m?decodeURIComponent(m[1]):null}if(p!=="light"&&p!=="dark")p="system";var path=location.pathname,lo=${JSON.stringify(LIGHT_ONLY_PREFIXES)}.some(function(x){return path===x||path.indexOf(x+"/")===0});var d=p==="dark"||(p==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);var el=document.documentElement,r=!lo&&d?"dark":"light";el.setAttribute("data-theme",r);el.setAttribute("data-theme-pref",p);if(!lo)document.cookie="${THEME_RESOLVED_COOKIE}="+r+"; Path=/; Max-Age=31536000; SameSite=Lax"}catch(e){}})();`;
