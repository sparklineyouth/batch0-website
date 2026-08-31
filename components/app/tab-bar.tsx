"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  PlayCircle,
  CheckCircle,
  MoreHorizontal,
  LayoutDashboard,
  Inbox,
  Users,
} from "lucide-react";

/**
 * Every icon the two tab bars use, keyed by name.
 *
 * A named map rather than `import * as Icons from "lucide-react"`: the
 * namespace import is a barrel, and in a client component it drags the whole
 * icon set into the bundle because nothing can tree-shake a dynamic
 * `Icons[name]` lookup. This is the app's most-loaded component; it ships seven
 * icons.
 */
const ICONS = {
  Home,
  PlayCircle,
  CheckCircle,
  MoreHorizontal,
  LayoutDashboard,
  Inbox,
  Users,
} as const;

export type TabIcon = keyof typeof ICONS;

export type Tab = {
  href: string;
  label: string;
  icon: TabIcon;
  /** Match only this exact path. Set on the section root, which is a prefix of
   *  every sibling and would otherwise light up permanently. */
  exact?: boolean;
  /** Small count on the icon — pending reviews, unread announcements. */
  badge?: number;
};

/**
 * The bottom tab bar — the app's only navigational element.
 *
 * On prefetch: these links deliberately do NOT pass `prefetch={false}`, unlike
 * the authed desktop sidebars. Those set it because `staleTimes.dynamic = 0`
 * (next.config.js) makes a prefetched dynamic payload stale on arrival, so
 * prefetching ~20 sidebar links is pure waste. That reasoning inverts here:
 * every route behind these four tabs has a `loading.tsx`, and for a route with
 * a loading boundary Next prefetches only the static shell — which is not
 * subject to staleTimes and is exactly what makes a tab tap paint instantly
 * instead of hanging on a blank frame. Four cheap static prefetches, and the
 * dynamic data still comes fresh.
 *
 * `pb-[var(--safe-bottom)]` is not optional: without the inset the bottom of
 * the bar sits under the iPhone home indicator and the middle tabs stop being
 * tappable. Targets are 60px tall, comfortably above the 44px floor, because
 * this gets used one-handed and in a hurry.
 *
 * AppShell reserves the height — a fixed bar over unpadded content hides the
 * last item of every list.
 */
export function TabBar({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper/90 pb-[var(--safe-bottom)] backdrop-blur-xl"
    >
      <ul className="mx-auto flex max-w-[32rem] sm:border-x sm:border-line">
        {tabs.map((tab) => {
          const active = tab.exact
            ? pathname === tab.href
            : pathname === tab.href || pathname.startsWith(tab.href + "/");
          const Icon = ICONS[tab.icon];
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`press flex h-[3.75rem] select-none flex-col items-center justify-center gap-1.5 active:scale-[0.96] ${
                  active ? "text-phosphor-ink" : "text-ink-faint"
                }`}
              >
                <span className="relative">
                  <Icon
                    className="h-[21px] w-[21px]"
                    strokeWidth={active ? 2.25 : 1.75}
                  />
                  {!!tab.badge && tab.badge > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 min-w-[16px] rounded-full bg-phosphor px-1 text-center font-mono text-[9px] font-semibold leading-4 text-on-phosphor">
                      {tab.badge > 99 ? "99+" : tab.badge}
                    </span>
                  )}
                </span>
                <span className="text-[10px] font-medium uppercase tracking-[0.1em]">
                  {tab.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
