import React from "react";
import { ThemedImage } from "@/components/themed-image";
import { Wordmark } from "@/components/wordmark";
import Link from "next/link";
import { getSiteConfig, type SiteConfig } from "@/lib/site-config";

// Footer can take an explicit config (lets a page render in a single
// pass without re-querying) or self-resolve when used inside a layout
// that doesn't already have one.
//
// Set as a session colophon: the exit line carries true state (`exited 0`
// is the shell convention for "nothing went wrong"), paths are lowercase
// nav, the entity line keeps its proper nouns.
export default async function Footer({ config }: { config?: SiteConfig }) {
  const resolved = config ?? (await getSiteConfig());
  const contactEmail = resolved.settings.contactEmail;
  const links = [
    { href: "/program", label: "/program" },
    { href: "/blog", label: "/blog" },
    { href: "/sponsors", label: "/sponsors" },
    { href: "/#faq", label: "/faq" },
    { href: "/apply", label: "/apply" },
    { href: "/login", label: "/login" },
  ];
  return (
    <footer className="relative overflow-hidden border-t border-line px-5 py-10 pb-safe sm:px-6">
      {/* The blue-hour skyline, full-bleed. object-bottom pins the lit
          horizon and treeline to the footer's lower edge, which keeps the
          whole upper band — where every link and the colophon sit — on
          dark sky rather than on the sunset. Decorative, so alt="". */}
      <ThemedImage
        night="/footer-night.png"
        day="/footer-day.png"
        alt=""
        fill
        sizes="100vw"
        className="object-cover object-bottom"
      />
      {/* Two scrims, both weak: a top wash so the colophon and nav clear
          AA on the sky, and a bottom lift only under the legal row where
          the horizon is brightest. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: "var(--footer-scrim)" }}
      />
      <div className="relative z-10 mx-auto max-w-[1100px]">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <Wordmark className="h-[18px] text-ink" />
            <p className="mt-3 text-sm leading-[1.6] text-ink-soft">
              a live, online startup accelerator for U.S. high schoolers. no
              equity taken; funding is never guaranteed.
            </p>
            <a
              href={`mailto:${contactEmail}`}
              className="link-ink mt-4 inline-block text-sm font-medium"
            >
              {contactEmail}
            </a>
            {/* TODO(RISH): official social profiles (Instagram/Discord/X) —
                linked in NEEDED_FACTS.md; no placeholder links until then. */}
          </div>

          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-x-12 gap-y-2.5 sm:grid-cols-3"
          >
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-sm text-ink-soft transition-colors hover:text-ink"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-line pt-5 text-[13px] text-ink-faint md:flex-row md:items-center">
          <span>
            © {new Date().getFullYear()} Sparkline Youth LLC. all rights
            reserved.
          </span>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <Link href="/terms" className="transition-colors hover:text-ink">
              /terms
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-ink">
              /privacy
            </Link>
            <Link href="/refund-policy" className="transition-colors hover:text-ink">
              /refund-policy
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
