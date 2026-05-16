"use client";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { Menu, X } from "lucide-react";

// Use absolute hrefs (`/#anchor`) so hash links still resolve when the
// navbar is rendered on subroutes like `/showcase` or `/cohort/[slug]`.
const LINKS = [
  { href: "/#how-it-works", label: "Program" },
  { href: "/#curriculum", label: "Curriculum" },
  { href: "/showcase", label: "Showcase" },
  { href: "/alumni", label: "Alumni" },
  { href: "/sponsors", label: "Sponsors" },
  { href: "/#faq", label: "FAQ" },
] as const;

export default function Navbar({
  authedHome,
}: {
  authedHome?: string | null;
}) {
  const isAuthed = !!authedHome;
  const [open, setOpen] = useState(false);
  // Portal target is only available after mount. We track this so the
  // drawer can be rendered into document.body — outside the <header>,
  // whose `backdrop-blur` would otherwise become the containing block
  // for any position:fixed descendant and trap the drawer in a 56px
  // strip behind the nav bar.
  const [mounted, setMounted] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const root = drawerRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a, button, input, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(focusTimer);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  const drawer =
    open && mounted
      ? createPortal(
          <div className="fixed inset-0 z-[100] md:hidden">
            <button
              type="button"
              aria-label="Close menu"
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="absolute inset-0 bg-black/85 backdrop-blur-md"
            />
            <aside
              ref={drawerRef}
              id="public-mobile-nav"
              role="dialog"
              aria-modal="true"
              aria-label="Site navigation"
              className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col border-l border-white/10 bg-zinc-950 p-5 pt-safe pb-safe shadow-[0_0_60px_rgba(0,0,0,0.6)]"
            >
              <div className="mb-6 flex items-center justify-between">
                <a href="/" className="flex items-center gap-2">
                  <Image src="/logo.svg" alt="" width={24} height={24} />
                  <span className="text-base font-semibold tracking-tight text-white">
                    Spark<span className="text-spark">Line</span> Youth
                  </span>
                </a>
                <button
                  ref={closeRef}
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close menu"
                  className="-mr-2 flex h-11 w-11 items-center justify-center rounded-md text-white/70 hover:bg-white/5 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <nav className="flex flex-col">
                {LINKS.map((l) => (
                  <a
                    key={l.href}
                    href={l.href}
                    onClick={() => setOpen(false)}
                    className="rounded-lg px-3 py-3 text-base font-medium text-white/85 hover:bg-white/5 hover:text-white"
                  >
                    {l.label}
                  </a>
                ))}
              </nav>
              <div className="mt-8 space-y-2.5 border-t border-white/10 pt-5">
                <a
                  href={isAuthed ? authedHome! : "/apply"}
                  onClick={() => setOpen(false)}
                  className="press flex w-full items-center justify-center gap-2 rounded-md bg-spark px-4 py-3 text-[15px] font-semibold text-black hover:bg-spark-200"
                >
                  {isAuthed ? "Go to dashboard" : "Apply"}
                  <span aria-hidden>→</span>
                </a>
                {!isAuthed && (
                  <a
                    href="/login"
                    onClick={() => setOpen(false)}
                    className="flex w-full items-center justify-center rounded-md border border-white/15 px-4 py-3 text-[15px] font-medium text-white/85 hover:border-white/30 hover:bg-white/5 hover:text-white"
                  >
                    Log in
                  </a>
                )}
              </div>
              <div className="mt-auto pt-8 text-center text-xs text-white/55">
                <a href="/terms" onClick={() => setOpen(false)} className="hover:text-white">
                  Terms
                </a>
                <span aria-hidden className="mx-2 text-white/25">·</span>
                <a href="/privacy" onClick={() => setOpen(false)} className="hover:text-white">
                  Privacy
                </a>
                <span aria-hidden className="mx-2 text-white/25">·</span>
                <a href="/refund-policy" onClick={() => setOpen(false)} className="hover:text-white">
                  Refunds
                </a>
              </div>
            </aside>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <header className="fixed top-0 inset-x-0 z-50 border-b border-white/10 bg-black/95 backdrop-blur supports-[backdrop-filter]:bg-black/80 pt-safe">
        <nav className="mx-auto max-w-6xl flex items-center justify-between px-5 sm:px-6 py-3.5">
        <a href="/" className="press flex items-center gap-2.5">
          <Image src="/logo.svg" alt="SparkLine Youth" width={26} height={26} priority />
          <span className="text-white font-semibold tracking-tight text-[17px]">
            Spark<span className="text-spark">Line</span> Youth
          </span>
        </a>
        <ul className="hidden md:flex items-center gap-8 text-[13px] font-medium text-white/75">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="press rounded px-1 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3">
          {!isAuthed && (
            <a
              href="/login"
              className="press hidden sm:inline-block text-[13px] font-medium text-white/70 hover:text-white"
            >
              Log in
            </a>
          )}
          <a
            href={isAuthed ? authedHome! : "/apply"}
            className="press inline-flex items-center gap-1.5 rounded-md bg-spark px-3.5 py-1.5 text-[13px] font-semibold text-black hover:bg-spark-200"
          >
            {isAuthed ? "Dashboard" : "Apply"}
            <span aria-hidden>→</span>
          </a>
          <button
            ref={openerRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="public-mobile-nav"
            className="md:hidden -mr-1 flex h-10 w-10 items-center justify-center rounded-md border border-white/10 text-white/75 hover:bg-white/5 hover:text-white"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
        </nav>
      </header>
      {drawer}
    </>
  );
}
