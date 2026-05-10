import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://sparklineyouth.org"),
  title: "SparkLine — The Startup Accelerator for High Schoolers",
  description:
    "SparkLine is a 4-week, fully virtual accelerator for high schoolers. Build a real startup, pitch real angel investors, get real funding. Just $97.",
  keywords: [
    "high school startup accelerator",
    "youth entrepreneurship",
    "teen entrepreneur program",
    "virtual accelerator",
    "SparkLine",
  ],
  openGraph: {
    title: "SparkLine — The Startup Accelerator for High Schoolers",
    description:
      "Build a real startup in 4 weeks. Pitch real angel investors. Get funded — before you graduate.",
    url: "https://sparklineyouth.org",
    siteName: "SparkLine",
    images: ["/og.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SparkLine — The Startup Accelerator for High Schoolers",
    description:
      "Build a real startup in 4 weeks. Pitch real angel investors. Get funded — before you graduate.",
  },
  icons: {
    icon: "/logo.svg",
    shortcut: "/logo.svg",
    apple: "/logo.svg",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-black text-white antialiased">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-lg focus:bg-spark focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-black"
        >
          Skip to content
        </a>
        <div id="main-content">{children}</div>
      </body>
    </html>
  );
}
