import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { GoogleAnalytics } from "@next/third-parties/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import "./athena-ui.css";
import { cn } from "@/lib/utils";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { ThemeProvider } from "@/components/athena/ThemeProvider";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

const siteUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.athena.uzskicorp.agency";
const title = "Athena — Know instantly.";
const description =
  "Stop hunting through docs and pinging teammates for answers. Ask Athena — get the exact document or the exact person, instantly.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  applicationName: "Athena",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title,
    description,
    url: siteUrl,
    siteName: "Athena",
    images: [
      {
        url: "/og-image.jpg",
        width: 1200,
        height: 630,
        alt: "Athena — Just ask.",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og-image.jpg"],
  },
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
  robots: {
    index: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Follows the device by default; ThemeProvider pins both tags to the
  // applied sheet when the user picks Light or Dark.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F9F9FA" },
    { media: "(prefers-color-scheme: dark)", color: "#202021" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      {/* data-theme / data-theme-pref are set before first paint by THEME_INIT_SCRIPT (see lib/theme.ts). */}
      <html lang="en" className={cn("font-sans", geist.variable, geistMono.variable)} suppressHydrationWarning>
        <head>
          <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        </head>
        <body>
          <ThemeProvider>{children}</ThemeProvider>
        </body>
        <Analytics />
        <GoogleAnalytics gaId="G-NFHB1M7VJY" />
      </html>
    </ClerkProvider>
  );
}
