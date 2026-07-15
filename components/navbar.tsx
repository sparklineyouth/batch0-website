"use client";
import React, { useEffect, useState } from "react";
import { Wordmark } from "@/components/wordmark";
import Link from "next/link";
import { track } from "@vercel/analytics";

// Use absolute hrefs (`/#anchor`) so hash links still resolve when the
// navbar is rendered on subroutes. Labels are paths — terminal grammar.
const LINKS = [
  { href: "/program", label: "/program" },
  { href: "/blog", label: "/blog" },
  { href: "/sponsors", label: "/sponsors" },
  { href: "/#faq", label: "/faq" },
] as const;

export default function Navbar({
  authedHome,
  cohortLabel = "the next cohort",
}: {
  authedHome?: string | null;
  cohortLabel?: string;
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
  // Chrome CTA (#3 of the page's three asks) speaks command grammar.
  const applyLabel = isAuthed ? "dashboard" : "$ apply";
  const applyLabelLong = isAuthed
    ? "dashboard"
    : `apply for ${cohortLabel.toLowerCase()}`;

  return (
    <header className="sticky top-0 z-50 border-b border-line bg-paper pt-safe">
      <nav
        aria-label="Site"
        className="mx-auto flex h-14 max-w-[1100px] items-center justify-between gap-4 px-5 sm:px-6"
      >
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <Wordmark className="h-[18px] text-ink" />
        </Link>

        <div className="hidden items-center gap-6 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="path-link text-sm text-ink-soft hover:text-ink"
            >
              {l.label}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          {!isAuthed && (
            <Link
              href="/login"
              className="path-link text-sm text-ink-soft hover:text-ink"
            >
              /login
            </Link>
          )}
          <Link
            href={applyHref}
            onClick={() => !isAuthed && track("apply_click", { location: "navbar" })}
            className="press bg-phosphor px-4 py-2 text-sm font-semibold text-on-phosphor hover:bg-phosphor-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            {applyLabel}
          </Link>
        </div>

        <div className="flex items-center gap-1.5 md:hidden">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="press -mr-1 flex h-10 w-10 items-center justify-center rounded-md text-ink"
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
                onClick={() => {
                  setOpen(false);
                  if (!isAuthed) track("apply_click", { location: "navbar-mobile" });
                }}
                className="press bg-phosphor px-4 py-3 text-center text-[15px] font-semibold text-on-phosphor"
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
