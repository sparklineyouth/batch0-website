"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Menu, X, Search, ChevronDown } from "lucide-react";
import {
  STUDENT_NAV_GROUPS,
  ADMIN_NAV_GROUPS,
  MENTOR_NAV_GROUPS,
  INVESTOR_NAV_GROUPS,
  STAFF_LINKS,
  ENROLLED_ONLY_HREFS,
  type NavGroup,
} from "@/lib/nav-config";
import type { Role } from "@/lib/types";
import { NotificationBell } from "@/components/notification-bell";

export type MobileNavKind = "student" | "admin" | "mentor" | "investor";

const GROUPS_BY_KIND: Record<MobileNavKind, NavGroup[]> = {
  student: STUDENT_NAV_GROUPS,
  admin: ADMIN_NAV_GROUPS,
  mentor: MENTOR_NAV_GROUPS,
  investor: INVESTOR_NAV_GROUPS,
};

const LABEL_BY_KIND: Record<MobileNavKind, string | undefined> = {
  student: undefined,
  admin: "Admin",
  mentor: "Mentor",
  investor: "Investor",
};

/**
 * Mobile-only header + slide-in drawer with the same categorized
 * structure as the desktop sidebar.
 */
export function MobileNav({
  kind,
  role,
  aiAccess,
  discordEnabled,
  enrolled = true,
  referralsEnabled = true,
}: {
  kind: MobileNavKind;
  role?: Role;
  aiAccess?: boolean;
  discordEnabled?: boolean;
  enrolled?: boolean;
  referralsEnabled?: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Refs for focus management: focus the close button when the drawer
  // opens, restore focus to the opener when it closes. Without these,
  // keyboard users get dropped into the page after closing.
  const openerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Move focus into the drawer and trap Tab inside it. Escape closes.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Defer until the drawer paints so refs resolve.
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
      // Restore focus to whatever opened the drawer (usually the menu button).
      previouslyFocused?.focus?.();
    };
  }, [open]);

  const rawGroups = GROUPS_BY_KIND[kind];
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rawGroups
      .map((g) => {
        const items = g.items
          .filter((it) => {
            if (kind === "student") {
              if (it.href === "/dashboard/ai" && aiAccess === false) {
                return false;
              }
              if (
                it.href === "/dashboard/community" &&
                discordEnabled === false
              ) {
                return false;
              }
              if (
                it.href === "/dashboard/referrals" &&
                referralsEnabled === false
              ) {
                return false;
              }
              if (!enrolled && ENROLLED_ONLY_HREFS.has(it.href)) return false;
            }
            if (kind === "admin") {
              // Admins keep the link visible when referrals are paused so
              // they can audit historical referral data; the page itself
              // shows a "paused" banner. Only filter it when explicitly
              // turned off AND we want a totally clean nav — current
              // policy is to keep it.
            }
            return true;
          })
          .filter((it) => (q ? it.label.toLowerCase().includes(q) : true));
        return { ...g, items };
      })
      .filter((g) => g.items.length > 0);
  }, [
    rawGroups,
    kind,
    aiAccess,
    discordEnabled,
    enrolled,
    referralsEnabled,
    query,
  ]);

  const label = LABEL_BY_KIND[kind];

  const extras: { href: string; label: string; icon: any }[] = [];
  if (role === "admin" && kind !== "admin") extras.push(STAFF_LINKS.admin);
  if ((role === "admin" || role === "mentor") && kind !== "mentor") {
    extras.push(STAFF_LINKS.mentor);
  }
  if ((role === "admin" || role === "investor") && kind !== "investor") {
    extras.push(STAFF_LINKS.investor);
  }

  function toggleGroup(label: string) {
    setCollapsed((p) => ({ ...p, [label]: !p[label] }));
  }
  const isSearching = query.trim().length > 0;

  return (
    <>
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-white/10 bg-black/80 px-4 backdrop-blur md:hidden">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.svg" alt="" width={22} height={22} />
          <span className="font-semibold tracking-tight text-white">
            Spark<span className="text-spark">Line</span> Youth
          </span>
          {label && (
            <span className="ml-2 rounded-full bg-spark/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-spark">
              {label}
            </span>
          )}
        </Link>
        <div className="flex items-center gap-2">
          <NotificationBell align="right" />
          <button
            ref={openerRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="mobile-nav-drawer"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-white/70 hover:bg-white/5 hover:text-white"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          />
          <aside
            ref={drawerRef}
            id="mobile-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Site navigation"
            className="absolute right-0 top-0 flex h-full w-72 flex-col border-l border-white/10 bg-zinc-950 p-4"
          >
            <div className="mb-4 flex items-center justify-between">
              <Link href="/" className="flex items-center gap-2">
                <Image src="/logo.svg" alt="" width={22} height={22} />
                <span className="font-semibold tracking-tight text-white">
                  Spark<span className="text-spark">Line</span> Youth
                </span>
              </Link>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-white/60 hover:bg-white/5 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter…"
                aria-label="Filter navigation"
                className="w-full rounded-lg border border-white/10 bg-black/30 py-2 pl-8 pr-3 text-sm text-white placeholder:text-white/30 focus:border-spark/40 focus:outline-none focus:ring-1 focus:ring-spark/30"
              />
            </div>

            <nav className="flex-1 space-y-3 overflow-y-auto pr-1">
              {visibleGroups.length === 0 && (
                <p className="px-2 py-4 text-xs text-white/40">
                  No matches for "{query}".
                </p>
              )}
              {visibleGroups.map((g, idx) => {
                const isOpen = isSearching || !collapsed[g.label];
                const hasLabel = g.label.length > 0;
                return (
                  <div key={g.label || `__top_${idx}`}>
                    {hasLabel && (
                      <button
                        type="button"
                        onClick={() => toggleGroup(g.label)}
                        aria-expanded={isOpen}
                        className="flex w-full items-center justify-between px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40 hover:text-white/70"
                      >
                        <span>{g.label}</span>
                        <ChevronDown
                          className={`h-3 w-3 transition-transform ${
                            isOpen ? "" : "-rotate-90"
                          }`}
                        />
                      </button>
                    )}
                    {isOpen && (
                      <div className="space-y-0.5">
                        {g.items.map((it) => {
                          const active = it.exact
                            ? pathname === it.href
                            : pathname?.startsWith(it.href);
                          const Icon = it.icon;
                          return (
                            <Link
                              key={it.href}
                              href={it.href}
                              aria-current={active ? "page" : undefined}
                              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                                active
                                  ? "bg-spark/10 text-spark"
                                  : "text-white/70 hover:bg-white/5 hover:text-white"
                              }`}
                            >
                              <Icon className="h-4 w-4 shrink-0" />
                              {it.label}
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {extras.length > 0 && (
                <div className="mt-2 space-y-0.5 border-t border-white/10 pt-3">
                  {extras.map((it) => {
                    const Icon = it.icon;
                    return (
                      <Link
                        key={it.href}
                        href={it.href}
                        className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-spark/80 hover:bg-spark/10 hover:text-spark"
                      >
                        {Icon ? <Icon className="h-4 w-4" /> : null}
                        {it.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </nav>
            <form action="/auth/signout" method="post" className="mt-4">
              <button
                type="submit"
                className="flex w-full items-center justify-center rounded-lg border border-white/10 px-3 py-2 text-sm text-white/70 hover:bg-white/5 hover:text-white"
              >
                Sign out
              </button>
            </form>
          </aside>
        </div>
      )}
    </>
  );
}
