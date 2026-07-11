import type { Metadata, Viewport } from "next";
import {
  Bricolage_Grotesque,
  Public_Sans,
  IBM_Plex_Mono,
} from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

// Type system (DESIGN.md): display with a pulse, body with a spine, mono
// for the receipts.
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
const sans = Public_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // viewport-fit=cover lets safe-area-inset-* expose the notch on iOS.
  viewportFit: "cover",
  // Browser chrome tracks the OS preference (matches defaultTheme: "system").
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0d" },
  ],
};

// The site serves from www (apex 307s there) — canonicals must match.
const SITE = "https://www.sparklineyouth.org";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  // 57 chars — search phrase first, brand last. Differentiates from the
  // crowded Spark* namespace (Spark Teen, SparkHub, SparkYouth NYC) by
  // saying exactly what this is: an accelerator, for high schoolers.
  title: "Startup Accelerator for High Schoolers — Sparkline Youth",
  description:
    "Sparkline Youth is a live, online startup accelerator for U.S. high schoolers. Cohort 1 runs Jul 30–Sep 13, 2026. $130 tuition, free to apply. No equity taken.",
  keywords: [
    "high school startup accelerator",
    "startup programs for high schoolers",
    "youth entrepreneurship program",
    "teen startup accelerator",
    "virtual accelerator",
    "Sparkline Youth",
  ],
  openGraph: {
    title: "Startup Accelerator for High Schoolers — Sparkline Youth",
    description:
      "A live, online startup accelerator for U.S. high schoolers. Build a real company in four sprint weeks, then pitch it at demo day. $130, free to apply, no equity taken.",
    url: SITE,
    siteName: "Sparkline Youth",
    // Image is generated dynamically by app/opengraph-image.tsx and picked
    // up automatically — no explicit `images:` entry needed here.
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Startup Accelerator for High Schoolers — Sparkline Youth",
    description:
      "A live, online startup accelerator for U.S. high schoolers. Build a real company in four sprint weeks, then pitch it at demo day. $130, free to apply, no equity taken.",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
};

// Structured data for search engines. Lives on every page (it's harmless
// duplication for crawlers and lets engines surface the org on any URL).
// Every value here is verifiable: cohort dates/price from the cohorts
// table, entity + contact from the footer, audience from the terms.
const orgJsonLd = {
  "@context": "https://schema.org",
  "@type": "EducationalOrganization",
  name: "Sparkline Youth",
  alternateName: "Sparkline",
  url: SITE,
  logo: `${SITE}/logo.svg`,
  description:
    "Sparkline Youth is a live, online startup accelerator for U.S. high schoolers, run by Impetus AI LLC. Students build a real company across four sprint weeks and pitch it at a live demo day. No equity is taken; sponsorship for standouts is merit-based and funding is never guaranteed.",
  parentOrganization: {
    "@type": "Organization",
    name: "Impetus AI LLC",
  },
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    email: "hello@sparklineyouth.org",
  },
  audience: {
    "@type": "EducationalAudience",
    educationalRole: "student",
    audienceType: "U.S. high school students, ages 13–18",
  },
  offers: {
    "@type": "Offer",
    price: "129.99",
    priceCurrency: "USD",
    category: "Tuition",
    description:
      "Cohort tuition, charged only if accepted. Free to apply. Reduced regional pricing available in select countries.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Marketing surface defaults to the visitor's system theme (light or dark),
  // toggleable from the navbar and remembered by next-themes. The marketing
  // design tokens (globals.css) flip off the `data-theme` attribute it sets on
  // <html>. The authenticated product layouts run their own cookie theme on the
  // <html> *class* list, so the two never collide. suppressHydrationWarning is
  // required: next-themes sets data-theme before hydration.
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
    >
      <body className="bg-paper font-sans text-ink antialiased">
        <ThemeProvider>
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-spark focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-on-spark"
          >
            Skip to content
          </a>
          <div id="main-content">{children}</div>
          <script
            type="application/ld+json"
            // JSON.stringify is safe here — the payload is a fixed literal,
            // no user input is interpolated.
            dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }}
          />
          <Analytics />
        </ThemeProvider>
      </body>
    </html>
  );
}
