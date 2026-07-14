import type { Metadata, Viewport } from "next";
import { VT323, IBM_Plex_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

// Type system (DESIGN.md): one idea — a terminal. VT323 is the DEC VT320
// face the logo is set in; it carries every display surface. IBM Plex Mono
// is the same terminal DNA with real weights and a readable lowercase, so
// it takes body copy and all dense product UI. VT323 ships a single 400
// weight — never apply font-bold to it (globals.css blocks synthesis).
const display = VT323({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
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

// The site serves from the apex; batchzero.org and the legacy
// sparklineyouth.org both redirect here, so canonicals must match this.
const SITE = "https://batch0.org";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  // Search phrase first, brand last: "batch0" carries no search intent yet,
  // so the page has to be findable by what it *is*, not what it's called.
  title: "Startup Accelerator for High Schoolers — batch0",
  description:
    "batch0 is a live, online startup accelerator for U.S. high schoolers. Cohort 1 runs Jul 30–Sep 13, 2026. $130 tuition, free to apply. No equity taken.",
  keywords: [
    "high school startup accelerator",
    "startup programs for high schoolers",
    "youth entrepreneurship program",
    "teen startup accelerator",
    "virtual accelerator",
    "batch0",
    // Legacy brand — people who knew the program by its old name still
    // search for it, and will until the new name has its own equity.
    "Sparkline Youth",
  ],
  openGraph: {
    title: "Startup Accelerator for High Schoolers — batch0",
    description:
      "A live, online startup accelerator for U.S. high schoolers. Build a real company in four sprint weeks, then pitch it at demo day. $130, free to apply, no equity taken.",
    url: SITE,
    siteName: "batch0",
    // Image is generated dynamically by app/opengraph-image.tsx and picked
    // up automatically — no explicit `images:` entry needed here.
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Startup Accelerator for High Schoolers — batch0",
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
  name: "batch0",
  // The former name, kept deliberately: it's how search engines and anyone
  // holding an old link connect the two entities across the rename.
  alternateName: "Sparkline Youth",
  url: SITE,
  logo: `${SITE}/icon-512.png`,
  description:
    "batch0 is a live, online startup accelerator for U.S. high schoolers. Students build a real company across four sprint weeks and pitch it at a live demo day. No equity is taken; sponsorship for standouts is merit-based and funding is never guaranteed.",
  legalName: "Sparkline Youth LLC",
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    email: "hello@batch0.org",
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
      className={`${display.variable} ${mono.variable}`}
    >
      <body className="bg-paper font-sans text-ink antialiased">
        <ThemeProvider>
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-phosphor focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-on-phosphor"
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
