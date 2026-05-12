"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import {
  STUDENT_NAV,
  ADMIN_NAV,
  MENTOR_NAV,
  INVESTOR_NAV,
  STAFF_LINKS,
} from "@/lib/nav-config";
import type { Role } from "@/lib/types";
import { NotificationBell } from "@/components/notification-bell";

export type MobileNavKind = "student" | "admin" | "mentor" | "investor";

const NAV_BY_KIND = {
  student: STUDENT_NAV,
  admin: ADMIN_NAV,
  mentor: MENTOR_NAV,
  investor: INVESTOR_NAV,
} as const;

const LABEL_BY_KIND: Record<MobileNavKind, string | undefined> = {
  student: undefined,
  admin: "Admin",
  mentor: "Mentor",
  investor: "Investor",
};

/**
 * Mobile-only header + slide-in drawer. Resolves its own nav items
 * from `kind` so server layouts only need to pass primitives — keeps
 * lucide-icon functions out of the server/client serialization boundary.
 */
// Same enrolled-only list as the desktop sidebar — keep these two in sync.
const ENROLLED_ONLY = new Set<string>([
  "/dashboard/course",
  "/dashboard/team",
  "/dashboard/checkin",
  "/dashboard/office-hours",
  "/dashboard/events",
  "/dashboard/resources",
  "/dashboard/files",
]);

export function MobileNav({
  kind,
  role,
  aiAccess,
  discordEnabled,
  enrolled = true,
}: {
  kind: MobileNavKind;
  /** Authenticated role, used to surface staff cross-links. */
  role?: Role;
  /** Whether the AI co-founder link should appear (student kind only). */
  aiAccess?: boolean;
  /** Whether the Community link should appear (student kind only). */
  discordEnabled?: boolean;
  /** Whether the enrolled-only nav items are shown (student kind only). */
  enrolled?: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const rawItems = NAV_BY_KIND[kind];
  const items =
    kind === "student"
      ? rawItems.filter((it) => {
          if (it.href === "/dashboard/ai" && aiAccess === false) return false;
          if (it.href === "/dashboard/community" && discordEnabled === false) {
            return false;
          }
          if (!enrolled && ENROLLED_ONLY.has(it.href)) return false;
          return true;
        })
      : rawItems;
  const label = LABEL_BY_KIND[kind];

  // Staff cross-links shown only when the user has access. `kind`
  // itself is which panel we're CURRENTLY in, so we drop that one.
  const extras: { href: string; label: string; icon: any }[] = [];
  if (role === "admin" && kind !== "admin") extras.push(STAFF_LINKS.admin);
  if ((role === "admin" || role === "mentor") && kind !== "mentor") {
    extras.push(STAFF_LINKS.mentor);
  }
  if ((role === "admin" || role === "investor") && kind !== "investor") {
    extras.push(STAFF_LINKS.investor);
  }

  return (
    <>
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-white/10 bg-black/80 px-4 backdrop-blur md:hidden">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.svg" alt="" width={22} height={22} />
          <span className="font-semibold tracking-tight text-white">
            Spark<span className="text-spark">Line</span>
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
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
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
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          />
          <aside className="absolute right-0 top-0 flex h-full w-72 flex-col border-l border-white/10 bg-zinc-950 p-4">
            <div className="mb-6 flex items-center justify-between">
              <Link href="/" className="flex items-center gap-2">
                <Image src="/logo.svg" alt="" width={22} height={22} />
                <span className="font-semibold tracking-tight text-white">
                  Spark<span className="text-spark">Line</span>
                </span>
              </Link>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-white/60 hover:bg-white/5 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto">
              {items.map((it) => {
                const active = it.exact
                  ? pathname === it.href
                  : pathname?.startsWith(it.href);
                const Icon = it.icon;
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition ${
                      active
                        ? "bg-spark/10 text-spark"
                        : "text-white/70 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {it.label}
                  </Link>
                );
              })}
              {extras.length > 0 && (
                <div className="mt-4 space-y-1 border-t border-white/10 pt-4">
                  {extras.map((it) => {
                    const Icon = it.icon;
                    return (
                      <Link
                        key={it.href}
                        href={it.href}
                        className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-spark/80 hover:bg-spark/10 hover:text-spark"
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
