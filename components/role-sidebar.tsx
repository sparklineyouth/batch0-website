"use client";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { LogOut, ShieldCheck } from "lucide-react";
import type { Role } from "@/lib/types";
import { INVESTOR_NAV_GROUPS } from "@/lib/nav-config";
import type { NavGroup } from "@/lib/nav-config";
import { NotificationBell } from "@/components/notification-bell";
import { SidebarNav } from "@/components/sidebar-nav";

export type RoleSidebarKind = "investor";

const GROUPS_BY_KIND: Record<RoleSidebarKind, NavGroup[]> = {
  investor: INVESTOR_NAV_GROUPS,
};

const LABEL_BY_KIND: Record<RoleSidebarKind, string> = {
  investor: "Investor",
};

/**
 * Generic role sidebar used by /investor. Resolves nav items from
 * `kind` so the parent server layout only passes primitives — keeps
 * lucide function refs out of the server/client serialization
 * boundary.
 */
export function RoleSidebar({
  kind,
  role,
}: {
  kind: RoleSidebarKind;
  role: Role;
}) {
  const groups = GROUPS_BY_KIND[kind];
  const label = LABEL_BY_KIND[kind];
  return (
    <aside className="hidden md:flex md:sticky md:top-0 md:h-screen w-60 shrink-0 flex-col border-r border-line bg-wash px-4 py-6 overflow-hidden">
      <div className="mb-2 flex items-center justify-between px-2">
        <Link href="/" className="flex items-center gap-2">
          <Wordmark className="h-5 text-ink" />
        </Link>
        <NotificationBell align="left" />
      </div>
      <p className="mb-4 px-2 text-[10px] font-mono font-semibold uppercase tracking-[0.2em] text-phosphor-ink">
        {label}
      </p>
      <SidebarNav storageKey={`role-${kind}`} groups={groups} />
      {role === "admin" && (
        <div className="mt-4 space-y-1 border-t border-line pt-4">
          <Link
            href="/admin"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-phosphor-ink hover:bg-phosphor/10"
          >
            <ShieldCheck className="h-4 w-4" />
            Admin panel
          </Link>
        </div>
      )}
      <form action="/auth/signout" method="post" className="mt-4">
        <button
          type="submit"
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-soft hover:bg-paper hover:text-ink"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </form>
    </aside>
  );
}
