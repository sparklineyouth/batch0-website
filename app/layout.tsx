import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // viewport-fit=cover lets safe-area-inset-* expose the notch on iOS.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

export const metadata: Metadata = {
  metadataBase: new URL("https://sparklineyouth.org"),
  title: "SparkLine Youth — The Startup Accelerator for High Schoolers",
  description:
    "SparkLine Youth is a 4-week, fully virtual accelerator for high schoolers. Build a real startup, pitch real angel investors, get real funding. Just $97.",
  keywords: [
    "high school startup accelerator",
    "youth entrepreneurship",
    "teen entrepreneur program",
    "virtual accelerator",
    "SparkLine Youth",
  ],
  openGraph: {
    title: "SparkLine Youth — The Startup Accelerator for High Schoolers",
    description:
      "Build a real startup in 4 weeks. Pitch real angel investors. Get funded — before you graduate.",
    url: "https://sparklineyouth.org",
    siteName: "SparkLine Youth",
    // Image is generated dynamically by app/opengraph-image.tsx and picked
    // up automatically — no explicit `images:` entry needed here.
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SparkLine Youth — The Startup Accelerator for High Schoolers",
    description:
      "Build a real startup in 4 weeks. Pitch real angel investors. Get funded — before you graduate.",
  },
  icons: {
    icon: "/logo.svg",
    shortcut: "/logo.svg",
    apple: "/logo.svg",
  },
};

// Structured data for search engines. Lives on every page (it's harmless
// duplication for crawlers and lets engines surface the org on any URL).
const orgJsonLd = {
  "@context": "https://schema.org",
  "@type": "EducationalOrganization",
  name: "SparkLine Youth",
  alternateName: "SparkLine",
  url: "https://sparklineyouth.org",
  logo: "https://sparklineyouth.org/logo.svg",
  description:
    "SparkLine Youth is a 4-week, fully virtual startup accelerator for U.S. high schoolers. Students build a real startup, pitch real angel investors, and get a shot at funding for $97.",
  sameAs: ["https://sparklineyouth.org"],
  address: {
    "@type": "PostalAddress",
    addressLocality: "Plainsboro",
    addressRegion: "NJ",
    addressCountry: "US",
  },
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    email: "sparkline.youth@gmail.com",
  },
  audience: {
    "@type": "EducationalAudience",
    educationalRole: "student",
    audienceType: "U.S. high school students, ages 13–18",
  },
  offers: {
    "@type": "Offer",
    price: "97",
    priceCurrency: "USD",
    category: "Tuition",
    description: "4-week virtual startup accelerator cohort tuition",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Marketing routes stay dark by default — the theme class is scoped
  // to authenticated layouts (admin / dashboard / mentor / investor) so
  // the public site never flips palette on a stale cookie.
  return (
    <html lang="en">
      <body className="bg-black text-white antialiased">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-lg focus:bg-spark focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-black"
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
      </body>
    </html>
  );
}
