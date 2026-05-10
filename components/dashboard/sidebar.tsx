"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import type { Role } from "@/lib/types";
import { STUDENT_NAV, STAFF_LINKS } from "@/lib/nav-config";
import { NotificationBell } from "@/components/notification-bell";

export function StudentSidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const showAdmin = role === "admin";
  const showProfessor = role === "admin" || role === "professor";
  const showMentor = role === "admin" || role === "mentor";
  const showInvestor = role === "admin" || role === "investor";
  const showStaff =
    showAdmin || showProfessor || showMentor || showInvestor;

  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-white/10 bg-zinc-950/40 px-4 py-6">
      <div className="mb-8 flex items-center justify-between px-2">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.svg" alt="" width={24} height={24} />
          <span className="font-semibold tracking-tight text-white">
            Spark<span className="text-spark">Line</span>
          </span>
        </Link>
        <NotificationBell />
      </div>
      <nav className="flex-1 space-y-1">
        {STUDENT_NAV.map((it) => {
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
        {showStaff && (
          <div className="mt-6 space-y-1 border-t border-white/10 pt-4">
            <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/30">
              Staff
            </p>
            {showAdmin && <StaffLink {...STAFF_LINKS.admin} />}
            {showProfessor && <StaffLink {...STAFF_LINKS.professor} />}
            {showMentor && <StaffLink {...STAFF_LINKS.mentor} />}
            {showInvestor && <StaffLink {...STAFF_LINKS.investor} />}
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

function StaffLink({
  href,
  label,
  icon: Icon,
}: {
  href: string;
  label: string;
  icon: any;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-spark/80 hover:bg-spark/10 hover:text-spark"
    >
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  );
}
