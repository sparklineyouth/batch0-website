"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  Home,
  FileText,
  PlayCircle,
  CreditCard,
  Settings,
  ShieldCheck,
  GraduationCap,
  ClipboardList,
  FolderOpen,
  LogOut,
} from "lucide-react";
import type { Role } from "@/lib/types";

export function StudentSidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const items = [
    { href: "/dashboard", label: "Home", icon: Home },
    { href: "/dashboard/application", label: "Application", icon: FileText },
    { href: "/dashboard/course", label: "Course", icon: PlayCircle },
    { href: "/dashboard/assignments", label: "Assignments", icon: ClipboardList },
    { href: "/dashboard/files", label: "Files", icon: FolderOpen },
    { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
    { href: "/dashboard/settings", label: "Settings", icon: Settings },
  ];
  // Strict allowlist — never show staff links on any non-staff role,
  // including unknown values that may slip through the synthesized
  // fallback profile.
  const showAdmin = role === "admin";
  const showProfessor = role === "admin" || role === "professor";
  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-white/10 bg-zinc-950/40 px-4 py-6">
      <Link href="/" className="mb-8 flex items-center gap-2 px-2">
        <Image src="/logo.svg" alt="" width={24} height={24} />
        <span className="font-semibold tracking-tight text-white">
          Spark<span className="text-spark">Line</span>
        </span>
      </Link>
      <nav className="flex-1 space-y-1">
        {items.map((it) => {
          const active =
            pathname === it.href ||
            (it.href !== "/dashboard" && pathname?.startsWith(it.href));
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
        {(showAdmin || showProfessor) && (
          <div className="mt-6 space-y-1 border-t border-white/10 pt-4">
            <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/30">
              Staff
            </p>
            {showAdmin && (
              <Link
                href="/admin"
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-spark/80 hover:bg-spark/10 hover:text-spark"
              >
                <ShieldCheck className="h-4 w-4" />
                Admin panel
              </Link>
            )}
            {showProfessor && (
              <Link
                href="/professor"
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-spark/80 hover:bg-spark/10 hover:text-spark"
              >
                <GraduationCap className="h-4 w-4" />
                Professor panel
              </Link>
            )}
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
