"use client";
import Link from "next/link";
import Image from "next/image";
import { LogOut, ShieldCheck } from "lucide-react";
import type { Role } from "@/lib/types";
import { MENTOR_NAV_GROUPS } from "@/lib/nav-config";
import { NotificationBell } from "@/components/notification-bell";
import { SidebarNav } from "@/components/sidebar-nav";

export function MentorSidebar({ role }: { role: Role }) {
  return (
    <aside className="hidden md:flex md:sticky md:top-0 md:h-screen w-60 shrink-0 flex-col border-r border-white/10 bg-zinc-950/40 px-4 py-6 overflow-hidden">
      <div className="mb-2 flex items-center justify-between px-2">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.svg" alt="" width={24} height={24} />
          <span className="font-semibold tracking-tight text-white">
            Spark<span className="text-spark">Line</span> Youth
          </span>
        </Link>
        <NotificationBell align="left" />
      </div>
      <p className="mb-4 px-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-spark">
        Mentor
      </p>
      <SidebarNav storageKey="mentor" groups={MENTOR_NAV_GROUPS} />
      {role === "admin" && (
        <div className="mt-4 space-y-1 border-t border-white/10 pt-4">
          <Link
            href="/admin"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-spark/80 hover:bg-spark/10 hover:text-spark"
          >
            <ShieldCheck className="h-4 w-4" />
            Admin panel
          </Link>
        </div>
      )}
      <form action="/auth/signout" method="post" className="mt-4">
        <button
          type="submit"
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-white/50 hover:bg-white/5 hover:text-white"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </form>
    </aside>
  );
}
