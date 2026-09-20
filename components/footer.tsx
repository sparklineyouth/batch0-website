import React from "react";
import { Wordmark } from "@/components/wordmark";
import Link from "next/link";
import { getPublicSiteConfig, type SiteConfig } from "@/lib/site-config";
import { CATEGORIES, CATEGORY_COPY, categoryPath } from "@/lib/blog-shared";

// Footer can take an explicit config (lets a page render in a single
// pass without re-querying) or self-resolve when used inside a layout
// that doesn't already have one.
//
// The self-resolving path uses the cacheable read deliberately. It is the
// footer of every legal page, and when it went through the no-store admin
// client it was — on its own, for one mailto: address — the reason /privacy,
// /terms and /refund-policy were rendered per-request instead of prerendered.
export default async function Footer({ config }: { config?: SiteConfig }) {
  const resolved = config ?? (await getPublicSiteConfig());
  const contactEmail = resolved.settings.contactEmail;
  const links = [
    { href: "/program", label: "Program" },
    { href: "/parents", label: "For parents" },
    { href: "/sample-lesson", label: "Sample lesson" },
    { href: "/start", label: "Free starter kit" },
    { href: "/blog", label: "Blog" },
    { href: "/sponsors", label: "Sponsors" },
    { href: "/#faq", label: "FAQ" },
    { href: "/apply", label: "Apply" },
    { href: "/login", label: "Log in" },
  ];
  return (
    <footer className="border-t border-line bg-wash px-5 py-12 pb-safe sm:px-6">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-8 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <div className="flex items-center gap-2">
            <Wordmark className="h-[18px] text-ink" />
          </div>
          <p className="mt-3 text-sm leading-[1.6] text-ink-soft">
            A live, online startup accelerator for high schoolers, ages
            13–18. No equity taken; funding is never guaranteed.
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

        <div className="flex flex-col gap-8 sm:flex-row sm:gap-12">
          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-2.5">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-sm text-ink-soft hover:text-ink"
              >
                {l.label}
              </Link>
            ))}
          </nav>

          {/* Category hubs, sitewide.
              A footer link appears on every page, which makes it the most
              persistent internal link available — and these six hubs are the
              only short path from anywhere on the site down to all 135 guides.
              Most of the blog isn't in Google's index yet; this is the kind of
              link that fixes that. */}
          <nav aria-label="Guides" className="grid grid-cols-2 gap-x-12 gap-y-2.5">
            <p className="col-span-2 font-mono text-[12px] uppercase tracking-[0.08em] text-ink-faint">
              Guides
            </p>
            {CATEGORIES.map((c) => (
              <Link
                key={c}
                href={categoryPath(c)}
                className="text-sm text-ink-soft hover:text-ink"
              >
                {CATEGORY_COPY[c].heading}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      <div className="mx-auto mt-10 flex max-w-[1100px] flex-col items-start justify-between gap-3 border-t border-line pt-6 text-[13px] text-ink-faint md:flex-row md:items-center">
        <span>
          © {new Date().getFullYear()} Sparkline Youth LLC. All rights reserved.
        </span>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <Link href="/terms" className="hover:text-ink">
            Terms
          </Link>
          <Link href="/privacy" className="hover:text-ink">
            Privacy
          </Link>
          <Link href="/refund-policy" className="hover:text-ink">
            Refund policy
          </Link>
        </div>
      </div>
    </footer>
  );
}
