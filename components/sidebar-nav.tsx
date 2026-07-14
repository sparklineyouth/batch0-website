"use client";
import { useMemo, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Search, X } from "lucide-react";
import type { NavGroup, NavItem } from "@/lib/nav-config";

type Props = {
  /** Stable key used to namespace the per-group collapse state in
   *  localStorage so each panel (admin/student/etc.) remembers its own. */
  storageKey: string;
  groups: NavGroup[];
  /** Optional pre-filter; lets parent strip out items the user can't
   *  access (e.g. enrolled-only links for unenrolled students). */
  filterItem?: (item: NavItem) => boolean;
};

const COLLAPSED_PREFIX = "batch0_nav_collapsed:";

/**
 * The canonical sidebar row. Nav links below and every per-role footer control
 * (staff links, "View as", sign out) share it, so one list of rows reads as one
 * list — previously the footer used rounded-lg/py-2 against the nav's
 * rounded-md/py-1.5 and the seam showed.
 *
 * Deliberately NOT phosphor: `bg-phosphor/10 + text-phosphor-ink` is the
 * "you are here" state (ACTIVE_ROW). Footer links wearing it looked selected on
 * every page; the section label above them does the grouping instead.
 */
export const SIDEBAR_ROW =
  "flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-sm text-ink-soft hover:bg-paper hover:text-ink";

const ACTIVE_ROW = "bg-phosphor/10 text-phosphor-ink font-medium";

/** Does `pathname` sit at or under this item's href?
 *
 *  Boundary-aware: a bare startsWith would let /admin/teams-archive match
 *  /admin/teams. `exact` items match only themselves. */
function isMatch(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

/**
 * Resolve the ONE active item: the longest href that matches the path.
 *
 * Plain prefix-matching lit up every ancestor too, so /admin/mentors/match
 * marked both "Mentors" and "Mentor match" active (and put aria-current="page"
 * on both — two "current" links is also an a11y violation). Longest-match
 * means the most specific link wins and every ancestor stands down.
 *
 * Resolved against the UNFILTERED groups so searching or role-filtering the
 * list can never change which item is current.
 */
function resolveActiveHref(
  pathname: string | null,
  groups: NavGroup[],
): string | null {
  if (!pathname) return null;
  let best: string | null = null;
  for (const g of groups) {
    for (const it of g.items) {
      if (isMatch(pathname, it) && (!best || it.href.length > best.length)) {
        best = it.href;
      }
    }
  }
  return best;
}

function loadCollapsed(key: string): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COLLAPSED_PREFIX + key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function saveCollapsed(key: string, state: Record<string, boolean>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      COLLAPSED_PREFIX + key,
      JSON.stringify(state),
    );
  } catch {}
}

export function SidebarNav({ storageKey, groups, filterItem }: Props) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const navRef = useRef<HTMLElement>(null);
  // Hydration safety: render with empty collapsed state on the server,
  // then hydrate from localStorage on mount. Avoids SSR/CSR mismatch.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setCollapsed(loadCollapsed(storageKey));
  }, [storageKey]);

  const activeHref = useMemo(
    () => resolveActiveHref(pathname, groups),
    [pathname, groups],
  );

  // Bring the current page into view. The admin nav is ~1100px of links in a
  // ~530px viewport, so the active item routinely sits below the fold — you'd
  // land on a page whose nav entry you couldn't see. Scroll the nav's own
  // scrollport only (never scrollIntoView, which would also yank the page).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !activeHref) return;
    const el = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el) return;
    const navBox = nav.getBoundingClientRect();
    const elBox = el.getBoundingClientRect();
    const PAD = 8;
    if (elBox.top < navBox.top) {
      nav.scrollTop -= navBox.top - elBox.top + PAD;
    } else if (elBox.bottom > navBox.bottom) {
      nav.scrollTop += elBox.bottom - navBox.bottom + PAD;
    }
  }, [activeHref, collapsed]);

  function toggle(label: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [label]: !prev[label] };
      saveCollapsed(storageKey, next);
      return next;
    });
  }

  // Apply optional filter, then apply the search query. We keep the
  // group structure (label) so the user can see which section a match
  // came from when filtering.
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .map((g) => {
        const items = g.items
          .filter((it) => (filterItem ? filterItem(it) : true))
          .filter((it) =>
            q ? it.label.toLowerCase().includes(q) : true,
          );
        return { ...g, items };
      })
      .filter((g) => g.items.length > 0);
  }, [groups, filterItem, query]);

  const isSearching = query.trim().length > 0;

  return (
    // min-h-0 lets the inner <nav> actually scroll when nested inside a
    // flex-col parent — without it, flex children default to their
    // content height and overflow-y-auto silently no-ops.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          aria-label="Filter navigation"
          className="w-full rounded-md border border-line bg-paper py-1.5 pl-8 pr-7 text-xs text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-1 focus:ring-phosphor/30"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => setQuery("")}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-ink-faint hover:text-ink"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <nav
        ref={navRef}
        className="scrollbar-thin flex-1 space-y-3 overflow-y-auto pr-1"
      >
        {visibleGroups.length === 0 && (
          <p className="px-2 py-4 text-xs text-ink-faint">
            No matches for "{query}".
          </p>
        )}
        {visibleGroups.map((g, idx) => {
          const isOpen = isSearching || !collapsed[g.label];
          const hasLabel = g.label.length > 0;
          return (
            <div key={g.label || `__top_${idx}`}>
              {hasLabel && (
                <button
                  type="button"
                  onClick={() => toggle(g.label)}
                  aria-expanded={isOpen}
                  className="group flex w-full items-center justify-between gap-2 px-3 pb-1 text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-ink-faint hover:text-ink"
                >
                  <span>{g.label}</span>
                  <ChevronDown
                    className={`h-3 w-3 transition-transform ${
                      isOpen ? "" : "-rotate-90"
                    }`}
                  />
                </button>
              )}
              {isOpen && (
                <div className="space-y-0.5">
                  {g.items.map((it) => {
                    const active = it.href === activeHref;
                    const Icon = it.icon;
                    return (
                      <Link
                        key={it.href}
                        href={it.href}
                        aria-current={active ? "page" : undefined}
                        className={`${SIDEBAR_ROW} ${active ? ACTIVE_ROW : ""}`}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {it.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}
