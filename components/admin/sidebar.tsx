"use client";
import Link from "next/link";
import Image from "next/image";
import { LogOut, Eye, Handshake, Briefcase } from "lucide-react";
import { ADMIN_NAV_GROUPS } from "@/lib/nav-config";
import { NotificationBell } from "@/components/notification-bell";
import { SidebarNav } from "@/components/sidebar-nav";

// Cross-panel links shown to admins only. Each route's layout already
// allows admins through (requireMentor/requireInvestor in lib/auth.ts),
// so these are pure navigation affordances.
const VIEW_AS_LINKS = [
  { href: "/dashboard", label: "Student view", icon: Eye },
  { href: "/mentor", label: "Mentor view", icon: Handshake },
  { href: "/investor", label: "Investor view", icon: Briefcase },
];

export function AdminSidebar() {
  return (
    <aside className="hidden md:flex md:sticky md:top-0 md:h-screen w-60 shrink-0 flex-col border-r border-line bg-wash px-4 py-6 overflow-hidden">
      <div className="mb-2 flex items-center justify-between px-2">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.svg" alt="" width={24} height={24} />
          <span className="font-display font-semibold tracking-tight text-ink">
            Spark<span className="text-spark-ink">Line</span> Youth
          </span>
        </Link>
        <NotificationBell align="left" />
      </div>
      <p className="mb-4 px-2 text-[10px] font-mono font-semibold uppercase tracking-[0.2em] text-spark-ink">
        Admin
      </p>
      <SidebarNav storageKey="admin" groups={ADMIN_NAV_GROUPS} />
      <div className="mt-4 border-t border-line pt-4">
        <p className="mb-1.5 px-3 text-[10px] font-mono font-semibold uppercase tracking-[0.2em] text-ink-faint">
          View as
        </p>
        <div className="space-y-0.5">
          {VIEW_AS_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-ink-soft hover:bg-paper hover:text-ink"
            >
              <l.icon className="h-4 w-4" />
              {l.label}
            </Link>
          ))}
        </div>
        <form action="/auth/signout" method="post" className="mt-3">
          <button
            type="submit"
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-soft hover:bg-paper hover:text-ink"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
