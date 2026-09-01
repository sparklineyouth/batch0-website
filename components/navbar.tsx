"use client";
import React, { useEffect, useState } from "react";
import { Wordmark } from "@/components/wordmark";
import Link from "next/link";
import { track } from "@vercel/analytics";
import { ThemeToggle } from "@/components/theme-toggle";
import { AuthLabel, useIsAuthed } from "@/components/auth-label";

// Use absolute hrefs (`/#anchor`) so hash links still resolve when the
// navbar is rendered on subroutes.
const LINKS = [
  { href: "/program", label: "Program" },
  { href: "/blog", label: "Blog" },
  { href: "/sponsors", label: "Sponsors" },
  { href: "/#faq", label: "FAQ" },
] as const;

/**
 * The marketing navbar.
 *
 * It used to take an `authedHome` prop, resolved on the server from the
 * session. That one prop is why six marketing routes — the homepage, the blog
 * index, and all 135 blog posts — rendered per-request instead of as static
 * HTML: producing it meant reading cookies, and reading cookies opts a route
 * out of prerendering entirely.
 *
 * So the CTA now points at the constant `/home`, which redirects server-side
 * (app/home/route.ts), and only the *word* on the button is auth-dependent.
 * That word is chosen in CSS from the `data-authed` flag stamped on <html>
 * before first paint, so the static HTML is correct on the first frame for
 * both audiences — nothing swaps, nothing shifts (see AuthLabel).
 */
export default function Navbar({
  cohortLabel = "the next cohort",
  overHero = false,
}: {
  cohortLabel?: string;
  /** Homepage only: the nav floats over the hero painting, so it drops its
   *  own background and hairline — <OverHeroChrome> owns both and paints
   *  them back once the visitor scrolls. Every other page renders the
   *  default sticky opaque bar, byte-identical to main's. */
  overHero?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isAuthed = useIsAuthed();

  // Close the mobile menu on escape; lock scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  // Constant on the server AND for the signed-out majority; /home sorts out
  // where a signed-in visitor actually belongs.
  const applyHref = "/home";
  const applyLabel = `Apply for ${cohortLabel}`;

  return (
    <header
      className={
        overHero
          ? "pt-safe"
          : "sticky top-0 z-50 border-b border-line bg-paper pt-safe"
      }
    >
      <nav
        aria-label="Site"
        className="mx-auto flex h-14 max-w-[1100px] items-center justify-between gap-4 px-5 sm:px-6"
      >
        <Link href="/" className="hero-nav-wordmark flex shrink-0 items-center gap-2">
          <Wordmark className="hero-chrome-type h-[18px] text-ink" />
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="hero-chrome-dim text-sm text-ink-soft transition-colors hover:text-ink"
            >
              {l.label}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <ThemeToggle className="hero-chrome-dim" />
          {/* Always rendered; `.when-anon` removes it outright for a
              signed-in visitor. The decision is made in CSS off the
              `data-authed` flag <html> carries before first paint, so the
              link is gone from the first frame rather than unmounting a tick
              after hydration — nothing shifts, and no dead gap is left
              behind where it used to be. See lib/auth-flag.ts. */}
          <Link
            href="/login"
            className="hero-chrome-dim when-anon text-sm text-ink-soft transition-colors hover:text-ink"
          >
            Log in
          </Link>
          <Link
            href={applyHref}
            // /home is force-dynamic and resolved in middleware — prefetching
            // it fires the redirect chain for real, on every marketing page
            // view, and `staleTimes.dynamic = 0` throws the result away
            // immediately. Same reasoning as components/dashboard/sidebar.tsx.
            prefetch={false}
            onClick={() => !isAuthed && track("apply_click", { location: "navbar" })}
            className="press rounded-md bg-phosphor px-4 py-2 text-sm font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            <AuthLabel signedOut={applyLabel} />
          </Link>
        </div>

        <div className="flex items-center gap-1.5 md:hidden">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="hero-chrome-type press -mr-1 flex h-10 w-10 items-center justify-center rounded-md text-ink"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              aria-hidden
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              {open ? (
                <path d="M4 4l12 12M16 4L4 16" />
              ) : (
                <path d="M3 5.5h14M3 10h14M3 14.5h14" />
              )}
            </svg>
          </button>
        </div>
      </nav>

      {/* Mobile menu — plain sheet under the header, no blur, no drama. */}
      {open && (
        <div id="mobile-menu" className="border-t border-line bg-paper md:hidden">
          <div className="mx-auto max-w-[1100px] space-y-1 px-5 py-4">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="block rounded-md px-2 py-2.5 text-[15px] font-medium text-ink hover:bg-wash"
              >
                {l.label}
              </Link>
            ))}
            <div className="flex flex-col gap-2 pt-3">
              <Link
                href={applyHref}
                prefetch={false}
                onClick={() => {
                  setOpen(false);
                  if (!isAuthed) track("apply_click", { location: "navbar-mobile" });
                }}
                className="press rounded-md bg-phosphor px-4 py-3 text-center text-[15px] font-semibold text-on-phosphor shadow-cta"
              >
                {isAuthed ? "Dashboard" : applyLabel}
              </Link>
              {!isAuthed && (
                <Link
                  href="/login"
                  onClick={() => setOpen(false)}
                  className="rounded-md border border-line px-4 py-3 text-center text-[15px] font-medium text-ink"
                >
                  Log in
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
