"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import type { Role } from "@/lib/types";
import { STUDENT_NAV, STAFF_LINKS } from "@/lib/nav-config";
import { NotificationBell } from "@/components/notification-bell";

// Links that only make sense once a student is enrolled in a cohort.
// Pre-enrollment they either 404 or throw a "you need to be enrolled"
// error — hide them to keep the sidebar clean.
const ENROLLED_ONLY = new Set<string>([
  "/dashboard/course",
  "/dashboard/team",
  "/dashboard/checkin",
  "/dashboard/office-hours",
  "/dashboard/events",
  "/dashboard/resources",
  "/dashboard/files",
]);

export function StudentSidebar({
  role,
  aiAccess,
  discordEnabled,
  enrolled,
}: {
  role: Role;
  aiAccess: boolean;
  discordEnabled: boolean;
  enrolled: boolean;
}) {
  const pathname = usePathname();
  const items = STUDENT_NAV.filter((it) => {
    if (it.href === "/dashboard/ai") return aiAccess;
    if (it.href === "/dashboard/community") return discordEnabled;
    if (!enrolled && ENROLLED_ONLY.has(it.href)) return false;
    return true;
  });
  // Only admins can preview the student view, so only admins get a
  // "back to my panel" cross-link. Mentors/investors never see student
  // chrome (middleware blocks them from /dashboard), so the old
  // showMentor/showInvestor cross-links were dead code.
  const showAdminBack = role === "admin";

  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-white/10 bg-zinc-950/40 px-4 py-6">
      <div className="mb-8 flex items-center justify-between px-2">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.svg" alt="" width={24} height={24} />
          <span className="font-semibold tracking-tight text-white">
            Spark<span className="text-spark">Line</span>
          </span>
        </Link>
        <NotificationBell align="right" />
      </div>
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
        {showAdminBack && (
          <div className="mt-6 space-y-1 border-t border-white/10 pt-4">
            <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/30">
              Staff
            </p>
            <StaffLink {...STAFF_LINKS.admin} />
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
