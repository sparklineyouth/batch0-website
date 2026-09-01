"use client";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { LogOut, ShieldCheck } from "lucide-react";
import type { Role } from "@/lib/types";
import { MENTOR_NAV_GROUPS } from "@/lib/nav-config";
import { canAccessAdmin, type Capabilities } from "@/lib/permissions";
import { NotificationBell } from "@/components/notification-bell";
import { SidebarNav, SIDEBAR_ROW } from "@/components/sidebar-nav";

export function MentorSidebar({
  role,
  caps,
}: {
  role: Role;
  caps?: Capabilities | null;
}) {
  // Permission-driven when the layout passes capabilities; the role
  // comparison is the pre-roles-table fallback.
  const showAdminBack = caps ? canAccessAdmin(caps) : role === "admin";
  return (
    <aside className="hidden md:flex md:sticky md:top-0 md:h-screen w-60 shrink-0 flex-col border-r border-line bg-wash px-4 py-6 overflow-hidden">
      <div className="mb-2 flex items-center justify-between px-2">
        <Link href="/" className="flex items-center gap-2">
          <Wordmark className="h-5 text-ink" />
        </Link>
        <NotificationBell align="left" />
      </div>
      <p className="mb-4 px-2 text-[10px] font-mono font-semibold uppercase tracking-[0.2em] text-phosphor-ink">
        Mentor
      </p>
      <SidebarNav storageKey="mentor" groups={MENTOR_NAV_GROUPS} />
      {showAdminBack && (
        <div className="mt-4 space-y-0.5 border-t border-line pt-4">
          {/* prefetch={false}: authed dynamic route + staleTimes.dynamic=0
              makes prefetched payloads throwaway work — see
              components/sidebar-nav.tsx. */}
          <Link href="/admin" prefetch={false} className={SIDEBAR_ROW}>
            <ShieldCheck className="h-4 w-4" />
            Admin panel
          </Link>
        </div>
      )}
      <form action="/auth/signout" method="post" className="mt-4">
        <button type="submit" className={SIDEBAR_ROW}>
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </form>
    </aside>
  );
}
