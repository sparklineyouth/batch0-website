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
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-white/10 bg-zinc-950/40 px-4 py-6">
      <div className="mb-2 flex items-center justify-between px-2">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.svg" alt="" width={24} height={24} />
          <span className="font-semibold tracking-tight text-white">
            Spark<span className="text-spark">Line</span>
          </span>
        </Link>
        <NotificationBell align="left" />
      </div>
      <p className="mb-4 px-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-spark">
        Admin
      </p>
      <SidebarNav storageKey="admin" groups={ADMIN_NAV_GROUPS} />
      <div className="mt-4 border-t border-white/10 pt-4">
        <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/30">
          View as
        </p>
        <div className="space-y-0.5">
          {VIEW_AS_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-white/55 hover:bg-white/5 hover:text-white"
            >
              <l.icon className="h-4 w-4" />
              {l.label}
            </Link>
          ))}
        </div>
        <form action="/auth/signout" method="post" className="mt-3">
          <button
            type="submit"
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-white/50 hover:bg-white/5 hover:text-white"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
