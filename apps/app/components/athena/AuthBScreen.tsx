"use client";

import { AuthenticateWithRedirectCallback, SignIn } from "@clerk/nextjs";
import { useSignIn } from "@clerk/nextjs/legacy";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import type { ResolvedTheme } from "@/lib/theme";
import { useResolvedTheme } from "./ThemeProvider";

const MARKETING_URL = "https://athena.uzskicorp.agency";

const clerkAppearance = {
  variables: {
    colorPrimary: "#171717",
    colorBackground: "#ffffff",
    colorText: "#171717",
    colorTextSecondary: "#6B6B70",
    colorInputBackground: "#ffffff",
    colorInputText: "#171717",
    colorNeutral: "#171717",
    colorDanger: "#B42318",
    borderRadius: "12px",
    fontFamily: "var(--font-sans), system-ui, sans-serif",
    fontFamilyButtons: "var(--font-sans), system-ui, sans-serif",
    fontSize: "15px",
  },
  elements: {
    rootBox: { width: "100%" },
    cardBox: { width: "100%", boxShadow: "none" },
    card: { width: "100%", boxShadow: "none", border: "0", background: "transparent" },
    headerTitle: {
      fontFamily: "var(--a-serif), Georgia, serif",
      fontSize: "24px",
      fontWeight: "400",
      letterSpacing: "-0.03em",
    },
    headerSubtitle: { fontSize: "14px", color: "#6B6B70" },
    formButtonPrimary: {
      backgroundColor: "#171717",
      fontSize: "15px",
      fontWeight: "400",
      borderRadius: "9999px",
      height: "48px",
      boxShadow: "none",
      "&:hover": { backgroundColor: "#2a2a2a" },
    },
    formFieldInput: {
      borderRadius: "12px",
      border: "1px solid #e4e4e7",
      fontSize: "16px",
      height: "44px",
      background: "#ffffff",
    },
    footerActionLink: { color: "#171717", fontWeight: "400" },
    dividerText: { color: "#9A9AA0" },
    dividerLine: { background: "#EFEFF0" },
    socialButtonsBlockButton: {
      border: "1px solid #EFEFF0",
      borderRadius: "9999px",
      height: "48px",
      background: "#ffffff",
      boxShadow: "none",
    },
    socialButtonsBlockButtonText: { color: "#171717", fontWeight: "400" },
  },
};

/** Dark twin of clerkAppearance (Doop TONEQO8FH4): borderless, no shadows. */
const clerkAppearanceDark = {
  variables: {
    colorPrimary: "#F2F2F3",
    colorPrimaryForeground: "#171717",
    colorBackground: "#202021",
    colorForeground: "#F2F2F3",
    colorMutedForeground: "#A8A8AD",
    colorMuted: "#2F2F30",
    colorInput: "#252526",
    colorInputForeground: "#F2F2F3",
    colorNeutral: "#F2F2F3",
    colorDanger: "#ED8078",
    colorSuccess: "#5DCAA0",
    colorWarning: "#E8B86D",
    colorBorder: "transparent",
    colorRing: "#F2F2F3",
    colorShadow: "transparent",
    colorModalBackdrop: "rgba(16, 16, 17, 0.64)",
    borderRadius: "12px",
    fontFamily: "var(--font-sans), system-ui, sans-serif",
    fontFamilyButtons: "var(--font-sans), system-ui, sans-serif",
    fontSize: "15px",
  },
  elements: {
    ...clerkAppearance.elements,
    headerTitle: { ...clerkAppearance.elements.headerTitle, color: "#F2F2F3" },
    headerSubtitle: { fontSize: "14px", color: "#A8A8AD" },
    formFieldLabel: { color: "#A8A8AD" },
    formButtonPrimary: {
      backgroundColor: "#F2F2F3",
      color: "#171717",
      fontSize: "15px",
      fontWeight: "400",
      borderRadius: "9999px",
      height: "48px",
      boxShadow: "none",
      border: "0",
      "&:hover": { backgroundColor: "#D8D8DC" },
      "&:focus-visible": { outline: "2px solid #F2F2F3", outlineOffset: "2px" },
    },
    formFieldInput: {
      borderRadius: "12px",
      border: "0",
      boxShadow: "none",
      fontSize: "16px",
      height: "44px",
      background: "#252526",
      color: "#F2F2F3",
      "&:focus": { outline: "2px solid #F2F2F3", outlineOffset: "2px", boxShadow: "none" },
    },
    otpCodeFieldInput: { border: "0", boxShadow: "none", background: "#252526", color: "#F2F2F3" },
    footerActionText: { color: "#A8A8AD" },
    footerActionLink: { color: "#F2F2F3", fontWeight: "400" },
    formResendCodeLink: { color: "#F2F2F3" },
    identityPreview: { border: "0", background: "#252526", boxShadow: "none" },
    identityPreviewText: { color: "#F2F2F3" },
    identityPreviewEditButton: { color: "#F2F2F3" },
    alternativeMethodsBlockButton: { border: "0", background: "#252526", color: "#F2F2F3", boxShadow: "none" },
    dividerText: { color: "#919198" },
    dividerLine: { background: "transparent" },
    socialButtonsBlockButton: {
      border: "0",
      borderRadius: "9999px",
      height: "48px",
      background: "#252526",
      boxShadow: "none",
      "&:hover": { background: "#2A2A2B" },
    },
    socialButtonsBlockButtonText: { color: "#F2F2F3", fontWeight: "400" },
    footer: { background: "transparent" },
  },
};

function useClerkAppearance(serverTheme?: ResolvedTheme) {
  return useResolvedTheme(serverTheme) === "dark" ? clerkAppearanceDark : clerkAppearance;
}

function clerkMessage(err: unknown): string {
  if (typeof err === "object" && err && "errors" in err) {
    const first = (err as { errors?: { longMessage?: string; message?: string }[] }).errors?.[0];
    if (first?.longMessage) return first.longMessage;
    if (first?.message) return first.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Please try again.";
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  );
}

function EyeIcon({ off }: { off?: boolean }) {
  if (off) {
    return (
      <svg width="16" height="16" viewBox="0 0 256 256" aria-hidden="true">
        <path
          fill="currentColor"
          d="M53.92 34.62a8 8 0 1 0-11.84 10.76l19.32 21.25C25 88.84 9.59 113.24 8.69 114.76a8 8 0 0 0 0 6.5c.35.79 8.82 19.57 27.65 38.4C61.43 194.74 93.12 208 128 208a127.11 127.11 0 0 0 52.07-10.83l22 24.21a8 8 0 1 0 11.84-10.76Zm47.33 75.87l41.27 45.4a32 32 0 0 1-41.27-45.4m142.06 10.27c-.35-.79-8.82-19.58-27.65-38.41C194.57 61.26 162.88 48 128 48c-16.85 0-32.93 3.39-47.69 9.58l27.3 30.03A48.08 48.08 0 0 1 176 128a47.39 47.39 0 0 1-3.46 17.84l28.62 31.49c23.1-19.53 34.2-39.21 35.15-41.3a8 8 0 0 0 0-6.5Z"
        />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 256 256" aria-hidden="true">
      <path
        fill="currentColor"
        d="M247.31 124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57 61.26 162.88 48 128 48S61.43 61.26 36.34 86.35C17.51 105.18 9 124 8.69 124.76a8 8 0 0 0 0 6.5c.35.79 8.82 19.57 27.65 38.4C61.43 194.74 93.12 208 128 208s66.57-13.26 91.66-38.34c18.83-18.83 27.3-37.61 27.65-38.4a8 8 0 0 0 0-6.5M128 192c-30.78 0-57.67-11.19-79.93-33.25A133.47 133.47 0 0 1 25 128a133.33 133.33 0 0 1 23.07-30.75C70.33 75.19 97.22 64 128 64s57.67 11.19 79.93 33.25A133.46 133.46 0 0 1 231.05 128c-7.21 13.46-38.62 64-103.05 64m0-112a48 48 0 1 0 48 48a48.05 48.05 0 0 0-48-48m0 80a32 32 0 1 1 32-32a32 32 0 0 1-32 32"
      />
    </svg>
  );
}

function BrandMark() {
  return (
    <span className="a-auth-mark">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/athena-knot.svg" alt="" width={24} height={24} />
      Athena
    </span>
  );
}

function AuthBForm({ serverTheme }: { serverTheme?: ResolvedTheme }) {
  const router = useRouter();
  const { isLoaded, signIn, setActive } = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"idle" | "password" | "google">("idle");
  const [handoff, setHandoff] = useState(false);

  const busy = pending !== "idle" || !isLoaded;
  const appearance = useClerkAppearance(serverTheme);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isLoaded || !signIn) return;
    const identifier = email.trim();
    if (!identifier || !password) {
      setError("Enter your work email and password.");
      return;
    }
    setError(null);
    setPending("password");
    try {
      const result = await signIn.create({ identifier, password });
      if (result.status === "complete" && result.createdSessionId) {
        await setActive({ session: result.createdSessionId });
        router.push("/dashboard");
        router.refresh();
        return;
      }
      // MFA, email code, or other continue steps stay on Clerk's hosted flow
      // so recovery and second factors keep working.
      setHandoff(true);
    } catch (err) {
      setError(clerkMessage(err));
    } finally {
      setPending("idle");
    }
  }

  async function onGoogle() {
    if (!isLoaded || !signIn) return;
    setError(null);
    setPending("google");
    try {
      await signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: "/login/sso-callback",
        redirectUrlComplete: "/dashboard",
      });
    } catch (err) {
      setError(clerkMessage(err));
      setPending("idle");
    }
  }

  if (handoff) {
    return (
      <div className="a-auth-card">
        <BrandMark />
        <div className="a-auth-clerk">
          <SignIn
            appearance={appearance}
            fallbackRedirectUrl="/dashboard"
            signUpUrl="/register"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="a-auth-card">
      <BrandMark />
      <h1 className="a-auth-title">Sign in to Athena</h1>
      <p className="a-auth-lede">Use your work email and password.</p>
      <form className="a-auth-form" onSubmit={onSubmit} noValidate>
        <button type="button" className="a-auth-google" onClick={onGoogle} disabled={busy}>
          <GoogleMark />
          Continue with Google
        </button>
        <div className="a-auth-or">or</div>
        <div className="a-field">
          <label className="a-label" htmlFor="auth-email">
            Work email
          </label>
          <input
            className={`a-auth-control${error ? " is-invalid" : ""}`}
            id="auth-email"
            name="email"
            type="email"
            autoComplete="username"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="a-field">
          <div className="a-auth-row">
            <label className="a-label" htmlFor="auth-password">
              Password
            </label>
            <Link className="a-auth-forgot" href="/login/forgot-password">
              Forgot password
            </Link>
          </div>
          <div className="a-auth-pw">
            <button
              type="button"
              className="a-auth-eye"
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((v) => !v)}
            >
              <EyeIcon off={showPassword} />
            </button>
            <input
              className={`a-auth-control${error ? " is-invalid" : ""}`}
              id="auth-password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
        {error ? (
          <p className="a-auth-help is-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="a-auth-submit" disabled={busy}>
          Sign in
          <svg width="15" height="15" viewBox="0 0 256 256" aria-hidden="true">
            <path
              fill="currentColor"
              d="m221.66 133.66-72 72a8 8 0 0 1-11.32-11.32L196.69 136H40a8 8 0 0 1 0-16h156.69l-58.35-58.34a8 8 0 0 1 11.32-11.32l72 72a8 8 0 0 1 0 11.32"
            />
          </svg>
        </button>
        <p className="a-auth-signup">
          Don&apos;t have an account? <Link href="/register">Create an account</Link>
        </p>
      </form>
    </div>
  );
}

function loginMode(pathname: string | null): "start" | "sso-callback" | "continue" {
  const rest = (pathname ?? "").replace(/^\/login\/?/, "");
  const segment = rest.split("/").filter(Boolean)[0];
  if (segment === "sso-callback") return "sso-callback";
  if (segment) return "continue";
  return "start";
}

export function AuthBScreen({ serverTheme }: { serverTheme?: ResolvedTheme } = {}) {
  const pathname = usePathname();
  const mode = useMemo(() => loginMode(pathname), [pathname]);
  const appearance = useClerkAppearance(serverTheme);

  return (
    <main className="a-root a-auth">
      <div className="a-auth-shell">
        <div className="a-auth-visual" role="img" aria-label="Dithered caryatids of the Erechtheion" />
        <div className="a-auth-main">
          {mode === "sso-callback" ? (
            <div className="a-auth-card">
              <BrandMark />
              <p className="a-auth-lede">Finishing sign in…</p>
              <AuthenticateWithRedirectCallback />
            </div>
          ) : mode === "continue" ? (
            <div className="a-auth-card">
              <BrandMark />
              <div className="a-auth-clerk">
                <SignIn
                  appearance={appearance}
                  fallbackRedirectUrl="/dashboard"
                  signUpUrl="/register"
                />
              </div>
            </div>
          ) : (
            <AuthBForm serverTheme={serverTheme} />
          )}
        </div>
        <div className="a-auth-foot">
          <div className="a-auth-legal">
            <a href={`${MARKETING_URL}/terms`}>Terms</a>
            <a href={`${MARKETING_URL}/privacy`}>Privacy</a>
          </div>
        </div>
      </div>
    </main>
  );
}
