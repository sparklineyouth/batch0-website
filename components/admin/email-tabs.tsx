"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Capabilities } from "@/lib/permissions";
import { canMeet } from "@/lib/permissions";
import { EMAIL_TABS } from "@/lib/nav-config";

/**
 * Sub-navigation for the email area — the sidebar has one Email row, these
 * tabs do the rest. Filtered with the same `canMeet()` the route guard uses,
 * so a tab is never a link to a 403.
 */
export function EmailTabs({ caps }: { caps: Capabilities | null }) {
  const pathname = usePathname();
  const visible = EMAIL_TABS.filter((t) => canMeet(caps, t.perm));
  if (visible.length < 2) return null;

  return (
    <nav className="mb-6 flex flex-wrap gap-1 border-b border-line pb-px">
      {visible.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + "/");
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-none ${
              active
                ? "border-phosphor text-ink"
                : "border-transparent text-ink-soft hover:border-line hover:text-ink"
            }`}
          >
            <Icon className="h-4 w-4" />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
