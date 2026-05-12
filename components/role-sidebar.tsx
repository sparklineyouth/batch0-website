"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { LogOut, ShieldCheck } from "lucide-react";
import type { Role } from "@/lib/types";
import { INVESTOR_NAV } from "@/lib/nav-config";
import { NotificationBell } from "@/components/notification-bell";

export type RoleSidebarKind = "investor";

const NAV_BY_KIND = {
  investor: INVESTOR_NAV,
} as const;

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
  const pathname = usePathname();
  const items = NAV_BY_KIND[kind];
  const label = LABEL_BY_KIND[kind];
  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-white/10 bg-zinc-950/40 px-4 py-6">
      <div className="mb-2 flex items-center justify-between px-2">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.svg" alt="" width={24} height={24} />
          <span className="font-semibold tracking-tight text-white">
            Spark<span className="text-spark">Line</span>
          </span>
        </Link>
        <NotificationBell align="right" />
      </div>
      <p className="mb-6 px-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-spark">
        {label}
      </p>
      <nav className="flex-1 space-y-1">
        {items.map((it) => {
          const active = it.exact
            ? pathname === it.href
            : pathname?.startsWith(it.href);
          const Icon = it.icon;
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                active
                  ? "bg-spark/10 text-spark"
                  : "text-white/60 hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon className="h-4 w-4" />
              {it.label}
            </Link>
          );
        })}
        {role === "admin" && (
          <div className="mt-6 space-y-1 border-t border-white/10 pt-4">
            <Link
              href="/admin"
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-spark/80 hover:bg-spark/10 hover:text-spark"
            >
              <ShieldCheck className="h-4 w-4" />
              Admin panel
            </Link>
          </div>
        )}
      </nav>
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
