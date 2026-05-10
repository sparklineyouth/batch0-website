"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { ArrowLeft, LogOut, ShieldCheck } from "lucide-react";
import type { Role } from "@/lib/types";
import { PROFESSOR_NAV } from "@/lib/nav-config";

export function ProfessorSidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-white/10 bg-zinc-950/40 px-4 py-6">
      <Link href="/" className="mb-2 flex items-center gap-2 px-2">
        <Image src="/logo.svg" alt="" width={24} height={24} />
        <span className="font-semibold tracking-tight text-white">
          Spark<span className="text-spark">Line</span>
        </span>
      </Link>
      <p className="mb-6 px-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-spark">
        Professor
      </p>
      <nav className="flex-1 space-y-1">
        {PROFESSOR_NAV.map((it) => {
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
        <div className="mt-6 space-y-1 border-t border-white/10 pt-4">
          {role === "admin" && (
            <Link
              href="/admin"
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-spark/80 hover:bg-spark/10 hover:text-spark"
            >
              <ShieldCheck className="h-4 w-4" />
              Admin panel
            </Link>
          )}
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-white/50 hover:bg-white/5 hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Student view
          </Link>
        </div>
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
