"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, FileText, Workflow, Send, Inbox, Settings } from "lucide-react";
import type { Capabilities, Permission } from "@/lib/permissions";
import { can } from "@/lib/permissions";

/**
 * Sub-navigation for the email area.
 *
 * The six pages here are one workflow — write a template, hang an automation
 * off it, watch the queue, check the numbers — and the global sidebar's flat
 * list buries that. Tabs also mean an admin who lands on "metrics" from a link
 * can find the templates without knowing the URL.
 *
 * Filtered by the viewer's permissions with the same `can()` the route guard
 * uses, so a tab is never a link to a 403.
 */

const TABS: { href: string; label: string; icon: typeof BarChart3; perm: Permission }[] = [
  { href: "/admin/email", label: "Metrics", icon: BarChart3, perm: "email.view" },
  { href: "/admin/email/templates", label: "Templates", icon: FileText, perm: "email.templates" },
  { href: "/admin/email/automations", label: "Automations", icon: Workflow, perm: "email.automate" },
  { href: "/admin/email/compose", label: "Compose", icon: Send, perm: "email.send" },
  { href: "/admin/email/outbox", label: "Outbox", icon: Inbox, perm: "email.view" },
  { href: "/admin/email/settings", label: "Settings", icon: Settings, perm: "email.settings" },
];

export function EmailTabs({ caps }: { caps: Capabilities | null }) {
  const pathname = usePathname();
  const visible = TABS.filter((t) => can(caps, t.perm));
  if (visible.length < 2) return null;

  return (
    <nav className="mb-6 flex flex-wrap gap-1 border-b border-line pb-px">
      {visible.map((t) => {
        // Longest-prefix, except for the metrics root — every other page lives
        // under /admin/email, so an exact match is the only way it isn't
        // permanently highlighted.
        const active =
          t.href === "/admin/email"
            ? pathname === "/admin/email"
            : pathname === t.href || pathname.startsWith(t.href + "/");
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
