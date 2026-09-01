"use client";
import Link from "next/link";
import { useCallback } from "react";
import { Wordmark } from "@/components/wordmark";
import { LogOut, Eye, Handshake, Briefcase } from "lucide-react";
import {
  ADMIN_NAV_GROUPS,
  filterAdminNavItem,
  type NavItem,
} from "@/lib/nav-config";
import { can, type Capabilities, type Permission } from "@/lib/permissions";
import { NotificationBell } from "@/components/notification-bell";
import { SidebarNav, SIDEBAR_ROW } from "@/components/sidebar-nav";

// Cross-panel links. Each is shown only when the viewer's role can actually
// reach that panel — an intern with no mentor permission shouldn't be offered
// a "Mentor view" link that bounces them straight back.
const VIEW_AS_LINKS: {
  href: string;
  label: string;
  icon: typeof Eye;
  perm: Permission;
}[] = [
  { href: "/dashboard", label: "Student view", icon: Eye, perm: "student.dashboard" },
  { href: "/mentor", label: "Mentor view", icon: Handshake, perm: "mentor.panel" },
  {
    href: "/investor",
    label: "Investor view",
    icon: Briefcase,
    perm: "investor.panel",
  },
];

export function AdminSidebar({ caps }: { caps: Capabilities }) {
  const filterItem = useCallback(
    (item: NavItem) => filterAdminNavItem(item, caps),
    [caps],
  );
  const viewAs = VIEW_AS_LINKS.filter((l) => can(caps, l.perm));

  return (
    <aside className="hidden md:flex md:sticky md:top-0 md:h-screen w-60 shrink-0 flex-col border-r border-line bg-wash px-4 py-6 overflow-hidden">
      <div className="mb-2 flex items-center justify-between px-2">
        <Link href="/" className="flex items-center gap-2">
          <Wordmark className="h-5 text-ink" />
        </Link>
        <NotificationBell align="left" />
      </div>
      <p className="mb-4 px-2 text-[10px] font-mono font-semibold uppercase tracking-[0.2em] text-phosphor-ink">
        Admin
      </p>
      <SidebarNav
        storageKey="admin"
        groups={ADMIN_NAV_GROUPS}
        filterItem={filterItem}
      />
      <div className="mt-4 border-t border-line pt-4">
        {viewAs.length > 0 && (
          <>
            <p className="mb-1.5 px-3 text-[10px] font-mono font-semibold uppercase tracking-[0.2em] text-ink-faint">
              View as
            </p>
            <div className="space-y-0.5">
              {/* prefetch={false}: authed dynamic routes + staleTimes.dynamic=0
                  makes prefetched payloads throwaway work — see
                  components/sidebar-nav.tsx. */}
              {viewAs.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  prefetch={false}
                  className={SIDEBAR_ROW}
                >
                  <l.icon className="h-4 w-4" />
                  {l.label}
                </Link>
              ))}
            </div>
          </>
        )}
        <form action="/auth/signout" method="post" className="mt-3">
          <button type="submit" className={SIDEBAR_ROW}>
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
