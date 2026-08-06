import type { Metadata, Viewport } from "next";
import { VT323, IBM_Plex_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { ThemeProvider } from "@/components/theme-provider";
import {
  SITE,
  ORG_ID,
  WEBSITE_ID,
  FOUNDERS,
  STUDENT_AUDIENCE,
  JsonLd,
} from "@/lib/schema";
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

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  // Search phrase first, brand last: "batch0" carries no search intent yet,
  // so the page has to be findable by what it *is*, not what it's called.
  title: "Startup Accelerator for High Schoolers — batch0",
  // Deliberately date-free. The earlier version of this string hardcoded the
  // cohort dates "mirroring" FALLBACK_COHORT, and drifted twice — production
  // spent weeks telling Google "Cohort 1 runs Jul 30–Sep 13" while the page
  // body said Sep 14. A build-time constant cannot track a database row, so
  // it no longer tries.
  //
  // The pages that should advertise dates now compute them per request:
  // `generateMetadata` in app/page.tsx and app/program/page.tsx call
  // `metaDescription()` from lib/site-config. This value is the inherited
  // default for every other route, where it is always true regardless of
  // where the cohort calendar sits.
  description:
    "batch0 is a live, online startup accelerator for high schoolers. Build a real company across four build sprints and pitch it at demo day. Free to apply, no equity taken.",
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
      "A live, online startup accelerator for U.S. high schoolers. Build a real company across four build sprints, then pitch it at demo day. $130, free to apply, no equity taken.",
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
      "A live, online startup accelerator for U.S. high schoolers. Build a real company across four build sprints, then pitch it at demo day. $130, free to apply, no equity taken.",
  },
  // Google Search Console ownership. Set GOOGLE_SITE_VERIFICATION in the
  // Vercel project env to the token Google gives you (the bare token, not the
  // whole meta tag) and this renders the verification tag on every page.
  //
  // Search Console is the only tool that answers "is Google actually indexing
  // us" — analytics can't, because a page that was never crawled sends no
  // events. Right now an exact-phrase search for a post title that exists
  // nowhere else on the internet returns nothing, so most of the 135 guides
  // are missing from the index and we have no visibility into which ones.
  //
  // Omitted entirely when unset, rather than rendering an empty tag.
  ...(process.env.GOOGLE_SITE_VERIFICATION
    ? {
        verification: {
          google: process.env.GOOGLE_SITE_VERIFICATION,
        },
      }
    : {}),
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

// ---------- Structured data for search engines ----------
// The org + site nodes live on every page (harmless duplication for
// crawlers, and it lets engines surface the org from any URL). Every value
// is verifiable: entity + contact from the footer, audience from the terms,
// people from the "Who runs this" section. Richer per-page types (Course,
// FAQPage, BlogPosting, sponsor offers) reference these two by `@id` — see
// lib/schema.tsx for why the ids matter.
//
// The tuition Offer here is the static base price, matching FALLBACK_COHORT
// in lib/site-config.ts. It is intentionally not read from the DB: this is
// the root layout, so a query here would hit every authenticated page too.
// Pages that need the live, regional price (/program) emit it themselves.
const orgJsonLd = {
  "@context": "https://schema.org",
  "@type": "EducationalOrganization",
  "@id": ORG_ID,
  name: "batch0",
  // The former name, kept deliberately: it's how search engines and anyone
  // holding an old link connect the two entities across the rename.
  alternateName: "Sparkline Youth",
  url: SITE,
  logo: {
    "@type": "ImageObject",
    url: `${SITE}/icon-512.png`,
    width: 512,
    height: 512,
  },
  description:
    "batch0 is a live, online startup accelerator for U.S. high schoolers. Students build a real company across four one-week build sprints and pitch it at a live demo day. No equity is taken; sponsorship for standouts is merit-based and funding is never guaranteed.",
  legalName: "Sparkline Youth LLC",
  founder: FOUNDERS,
  foundingDate: "2026",
  email: "hello@batch0.org",
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    email: "hello@batch0.org",
    availableLanguage: "English",
  },
  audience: STUDENT_AUDIENCE,
  // What the program actually teaches. Topical signals for an entity with
  // no brand search volume yet; each one is a section of the /program
  // syllabus, not an aspiration.
  knowsAbout: [
    "Startup accelerators",
    "Youth entrepreneurship",
    "Startup idea validation",
    "Customer interviews",
    "MVP development",
    "Go-to-market strategy",
    "Pitch decks",
  ],
  offers: {
    "@type": "Offer",
    price: "129.99",
    priceCurrency: "USD",
    category: "Tuition",
    availability: "https://schema.org/LimitedAvailability",
    description:
      "Cohort tuition, charged only if accepted. Free to apply. Reduced regional pricing available in select countries.",
  },
  // TODO(RISH): `sameAs` — the official Instagram/Discord/X handles, once
  // they exist (NEEDED_FACTS.md #11; the footer carries the same TODO).
  // Left off deliberately rather than guessed: `sameAs` asserts that an
  // account *is* this organization, so a wrong handle hands the brand
  // entity to someone else's profile. Add to this one place when known.
};

// WebSite node — establishes the site itself as an entity and gives every
// page a single `isPartOf` target. No `potentialAction`/SearchAction: the
// site has no search endpoint, and declaring one that doesn't work is a
// structured-data error rather than a free sitelinks box.
const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": WEBSITE_ID,
  name: "batch0",
  alternateName: "Sparkline Youth",
  url: SITE,
  description:
    "A live, online startup accelerator for high schoolers. Build a real company, pitch it at demo day.",
  publisher: { "@id": ORG_ID },
  inLanguage: "en-US",
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
          <JsonLd data={orgJsonLd} />
          <JsonLd data={websiteJsonLd} />
          <Analytics />
          {/* Real-user Core Web Vitals. Like <Analytics />, the script 404s on
              localhost by design and resolves on Vercel; data only appears once
              Speed Insights is enabled for the project in the dashboard. */}
          <SpeedInsights />
        </ThemeProvider>
      </body>
    </html>
  );
}
