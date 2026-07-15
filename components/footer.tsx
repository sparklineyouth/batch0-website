import React from "react";
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
    <footer className="border-t border-phosphor/25 px-5 py-10 pb-safe sm:px-6">
      <div className="mx-auto max-w-[1100px]">
        <p className="font-mono text-[12.5px] text-phosphor/60">
          $ logout <b className="font-medium text-phosphor">· exited 0</b> ·
          connection to batch0 closed
          <span
            aria-hidden
            className="cursor-block"
            style={{ background: "rgba(255,187,0,.62)" }}
          />
        </p>

        <div className="mt-7 flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
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
                className="path-link text-sm text-ink-soft hover:text-ink"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-9 flex flex-col items-start justify-between gap-3 border-t border-line pt-5 text-[13px] text-ink-faint md:flex-row md:items-center">
          <span>
            © {new Date().getFullYear()} Sparkline Youth LLC. all rights
            reserved.
          </span>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <Link href="/terms" className="path-link hover:text-ink">
              /terms
            </Link>
            <Link href="/privacy" className="path-link hover:text-ink">
              /privacy
            </Link>
            <Link href="/refund-policy" className="path-link hover:text-ink">
              /refund-policy
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
