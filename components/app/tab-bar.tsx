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
  /**
   * Extra path prefixes this tab owns.
   *
   * Some screens are reached through a tab but do not live under its href —
   * Announcements and Events hang off More by design. Without this every tab
   * renders inactive on those screens, so the bar says "you are nowhere" on
   * two real destinations. Adopting them here keeps the tab that got you
   * there lit.
   */
  match?: string[];
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
 * this gets used one-handed and in a hurry — hence `[--press-scale:0.96]`
 * below, a deeper press than the shell's 0.98 default. It is set as a variable
 * rather than `active:scale-[0.96]` because `.press:active` in globals.css and
 * a Tailwind `active:` utility both weigh (0,2,0) and the utilities are emitted
 * first, so the shared rule silently won every tie and every differentiated
 * press state in the app collapsed to the same 0.98.
 *
 * The border, fill, blur and the bottom inset all sit on ONE `max-w-[32rem]`
 * box, not split between the full-bleed <nav> and the list. Two reasons, in
 * order of who they hurt: the inset has to be on whatever paints the fill, or
 * the home-indicator strip under a notched iPhone is left unpainted; and the
 * chrome has to be on the constrained box, or at desktop widths a 512px column
 * of tabs floats above a viewport-wide rule that <main> (also 512px) never
 * draws.
 *
 * There is deliberately no `--safe-left`/`--safe-right` padding to match.
 * Those insets are 0 in portrait on every device, and the only thing that
 * makes them non-zero — landscape on a phone with a sensor housing — puts the
 * viewport at 780px or more, where `mx-auto` has already centred this 512px
 * box hundreds of pixels clear of both edges. Padding here would be inert in
 * the case that matters and, in the case that doesn't, would inset from the
 * box rather than from the screen.
 *
 * AppShell reserves the height — a fixed bar over unpadded content hides the
 * last item of every list.
 */
export function TabBar({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-40">
      <div className="mx-auto max-w-[32rem] border-t border-line bg-paper/90 pb-[var(--safe-bottom)] backdrop-blur-xl sm:border-x sm:border-line">
        <ul className="flex">
          {tabs.map((tab) => {
            const active =
              (tab.exact
                ? pathname === tab.href
                : pathname === tab.href ||
                  pathname.startsWith(tab.href + "/")) ||
              !!tab.match?.some(
                (p) => pathname === p || pathname.startsWith(p + "/"),
              );
            const Icon = ICONS[tab.icon];
            return (
              <li key={tab.href} className="flex-1">
                <Link
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  // The badge is aria-hidden, so the count has to reach a
                  // screen reader from here. Left in the markup it also came
                  // first in the accessible name and the tab announced as
                  // "12 Review".
                  aria-label={
                    tab.badge ? `${tab.label}, ${tab.badge} pending` : undefined
                  }
                  className={`press flex h-[3.75rem] select-none flex-col items-center justify-center gap-1.5 [--press-scale:0.96] ${
                    active ? "text-phosphor-ink" : "text-ink-faint"
                  }`}
                >
                  <span className="relative">
                    <Icon
                      className="h-[21px] w-[21px]"
                      strokeWidth={active ? 2.25 : 1.75}
                    />
                    {!!tab.badge && tab.badge > 0 && (
                      // Anchored outboard of the 21px glyph, not on top of it:
                      // at 320px with four tabs a three-glyph "99+" is ~24px
                      // wide and covered most of the icon it was annotating.
                      // The count is not capped at 9+ — an exact queue depth is
                      // the entire reason this badge is worth drawing.
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute -right-3.5 -top-2 min-w-[16px] rounded-full bg-phosphor px-1 text-center font-mono text-[9px] font-semibold leading-4 text-on-phosphor"
                      >
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
      </div>
    </nav>
  );
}
