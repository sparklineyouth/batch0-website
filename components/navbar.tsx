"use client";
import React, { useEffect, useState } from "react";
import { Wordmark } from "@/components/wordmark";
import Link from "next/link";
import { track } from "@vercel/analytics";
import { ThemeToggle } from "@/components/theme-toggle";
import { ApplyCta } from "@/components/apply-cta";

// Use absolute hrefs (`/#anchor`) so hash links still resolve when the
// navbar is rendered on subroutes.
const LINKS = [
  { href: "/program", label: "/program" },
  { href: "/blog", label: "/blog" },
  { href: "/sponsors", label: "/sponsors" },
  { href: "/#faq", label: "/faq" },
] as const;

export default function Navbar({
  authedHome,
  cohortLabel = "the next cohort",
  overHero = false,
}: {
  authedHome?: string | null;
  cohortLabel?: string;
  /** Homepage only: the nav floats over the hero image, so it drops its
   *  own background and hairline — <OverHeroChrome> owns both, and paints
   *  them back in once the visitor scrolls. Every other page renders the
   *  default sticky opaque bar unchanged. */
  overHero?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isAuthed = !!authedHome;

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

  const applyHref = isAuthed ? authedHome! : "/apply";
  const applyLabelLong = isAuthed
    ? "dashboard"
    : `apply for ${cohortLabel.toLowerCase()}`;

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

        <div className="hidden items-center gap-6 md:flex">
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
          {!isAuthed && (
            <Link
              href="/login"
              className="hero-chrome-dim text-sm text-ink-soft transition-colors hover:text-ink"
            >
              /login
            </Link>
          )}
          {isAuthed ? (
            <Link
              href={applyHref}
              className="press bg-phosphor-fill px-4 py-2 text-sm font-semibold lowercase text-on-phosphor hover:bg-phosphor-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
            >
              dashboard
            </Link>
          ) : (
            <ApplyCta label="apply" size="sm" location="navbar" />
          )}
        </div>

        <div className="flex items-center gap-1.5 md:hidden">
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
            <div className="px-2 py-2.5"><ThemeToggle /></div>
            <div className="flex flex-col gap-2 pt-3">
              <Link
                href={applyHref}
                onClick={() => {
                  setOpen(false);
                  if (!isAuthed) track("apply_click", { location: "navbar-mobile" });
                }}
                className="press bg-phosphor-fill px-4 py-3 text-center text-[15px] font-semibold text-on-phosphor"
              >
                {applyLabelLong}
              </Link>
              {!isAuthed && (
                <Link
                  href="/login"
                  onClick={() => setOpen(false)}
                  className="border border-line px-4 py-3 text-center text-[15px] font-medium text-ink"
                >
                  log in
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
