"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 56);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        height: 72,
        display: "flex",
        alignItems: "center",
        background: scrolled ? "var(--surface)" : "transparent",
        borderBottom: scrolled ? "1px solid var(--border)" : "none",
        backdropFilter: scrolled ? "blur(12px)" : "none",
        transition: "background 200ms ease-out, border-color 200ms ease-out",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 1200,
          margin: "0 auto",
          padding: "0 var(--space-6)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-4)",
        }}
      >
        <Link
          href="/"
          style={{ textDecoration: "none", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}
        >
          <Image
            src="/athena-mind-logo.png"
            alt="Athena"
            width={66}
            height={36}
            style={{
              height: 36,
              width: "auto",
              filter: scrolled ? "none" : "invert(1)",
              transition: "filter 200ms ease-out",
            }}
          />
          <span
            style={{
              color: scrolled ? "var(--foreground)" : "#ffffff",
              fontWeight: 400,
              fontSize: 15,
              letterSpacing: "-0.01em",
              transition: "color 200ms ease-out",
            }}
          >
            Athena
          </span>
        </Link>

        <nav style={{ display: "flex", alignItems: "center", gap: "var(--space-6)" }}>
          <a
            href="#features"
            className="nav-desktop-link"
            style={{
              textDecoration: "none",
              fontSize: 14,
              fontWeight: 400,
              color: scrolled ? "var(--foreground-muted)" : "rgba(255,255,255,0.75)",
              transition: "color 200ms ease-out",
            }}
          >
            Features
          </a>
          <a
            href="#how-it-works"
            className="nav-desktop-link"
            style={{
              textDecoration: "none",
              fontSize: 14,
              fontWeight: 400,
              color: scrolled ? "var(--foreground-muted)" : "rgba(255,255,255,0.75)",
              transition: "color 200ms ease-out",
            }}
          >
            How it works
          </a>
          <Link
            href="https://app.athena.uzskicorp.agency/register"
            style={{
              textDecoration: "none",
              height: 40,
              display: "inline-flex",
              alignItems: "center",
              borderRadius: 9999,
              padding: "0 20px",
              fontSize: 14,
              fontWeight: 400,
              whiteSpace: "nowrap",
              transition: "background 200ms ease-out, color 200ms ease-out, border-color 200ms ease-out",
              ...(scrolled
                ? {
                    background: "var(--foreground)",
                    color: "var(--background)",
                    border: "none",
                  }
                : {
                    background: "rgba(255,255,255,0.12)",
                    color: "#ffffff",
                    border: "1px solid rgba(255,255,255,0.55)",
                  }),
            }}
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}
