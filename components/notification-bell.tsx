"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/app/notifications/actions";
import { formatRelativeTime } from "@/lib/format-time";

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

/** Short unique-per-mount suffix for realtime channel topics. */
function uniqueSuffix(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}

type Align = "left" | "right";

/**
 * Notification bell. `align` controls which edge the dropdown anchors to
 * relative to the bell button (default "right" — works for top-right bell
 * placements; use "left" when the bell sits at the start of a row).
 */
export function NotificationBell({ align = "right" }: { align?: Align } = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  // Portal target isn't available until mount; gate render on this so SSR
  // doesn't try to call createPortal.
  const [mounted, setMounted] = useState(false);
  // Bell button + portaled dropdown live in different trees, so we need
  // both refs for click-outside detection.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Computed viewport-relative coordinates for the portaled dropdown.
  // Recalculated on open + on scroll/resize while open.
  const [pos, setPos] = useState<{
    top: number;
    left?: number;
    right?: number;
  } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Fetch on mount + every 60s. Filters by user_id as defense-in-depth
  // even though RLS already enforces it.
  async function load() {
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setItems([]);
        return;
      }
      const { data, error } = await supabase
        .from("notifications")
        .select("id, type, title, body, link, read_at, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(12);
      if (error) throw error;
      setItems((data as Notification[]) ?? []);
    } catch (err) {
      console.error("[notification-bell] load failed", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    load();

    // Live updates via Supabase Realtime — replaces the 60s poll. Falls
    // back to a slower poll in case Realtime isn't enabled on the project.
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let userId: string | null = null;

    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (cancelled || !user) return;
      userId = user.id;
      // Unique topic per mount. The browser Supabase client is a singleton,
      // so a stable name like `notif-<id>` gets REUSED across React Strict
      // Mode's dev double-mount; adding postgres_changes callbacks to that
      // already-subscribed channel throws. A per-mount suffix guarantees a
      // fresh channel every time; cleanup removes it.
      const topic = `notif-${user.id}-${uniqueSuffix()}`;
      const ch = supabase
        .channel(topic)
        .on(
          "postgres_changes" as any,
          {
            event: "INSERT",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${user.id}`,
          },
          (payload: any) => {
            const n = payload.new as Notification;
            setItems((prev) => {
              if (prev.find((p) => p.id === n.id)) return prev;
              return [n, ...prev].slice(0, 12);
            });
          },
        )
        .on(
          "postgres_changes" as any,
          {
            event: "UPDATE",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${user.id}`,
          },
          (payload: any) => {
            const n = payload.new as Notification;
            setItems((prev) =>
              prev.map((p) => (p.id === n.id ? { ...p, ...n } : p)),
            );
          },
        )
        .subscribe();
      channel = ch;
      // If the effect was torn down while we were awaiting getUser(), the
      // cleanup already ran (with channel still null) — remove now so we
      // don't leak a live subscription.
      if (cancelled) {
        supabase.removeChannel(ch);
        channel = null;
      }
    })();

    // Safety net: re-sync once a minute in case a Realtime event was missed.
    const safety = setInterval(load, 60_000);

    return () => {
      cancelled = true;
      clearInterval(safety);
      // removeChannel (not just unsubscribe) evicts the channel from the
      // client registry. Otherwise a remount — e.g. React Strict Mode's
      // double-invoke in dev — reuses the same-named, already-subscribed
      // channel and re-adding postgres_changes callbacks throws
      // "cannot add ... callbacks after subscribe()".
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  // Refresh when reopening so we don't miss anything that arrived
  // while the dropdown was closed (covers Realtime drops on weak connections).
  useEffect(() => {
    if (open) load();
  }, [open]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      // Dropdown is portaled to <body>, so it's NOT a descendant of the
      // bell wrapper. Check both refs separately.
      if (
        !buttonRef.current?.contains(target) &&
        !dropdownRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", onClick);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("mousedown", onClick);
        document.removeEventListener("keydown", onKey);
      };
    }
  }, [open]);

  // Anchor the portaled dropdown to the bell button using viewport
  // coordinates. Using position: fixed means the dropdown escapes every
  // ancestor's overflow / containing-block rules (the dashboard sidebars
  // are `md:sticky overflow-hidden`, which used to clip the dropdown's
  // right edge because the dropdown is 22rem wide but the sidebar is
  // only 15rem).
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    function updatePos() {
      const rect = buttonRef.current!.getBoundingClientRect();
      const offsetY = rect.bottom + 8;
      if (align === "right") {
        setPos({
          top: offsetY,
          right: Math.max(12, window.innerWidth - rect.right),
        });
      } else {
        setPos({ top: offsetY, left: Math.max(12, rect.left) });
      }
    }
    updatePos();
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return () => {
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
  }, [open, align]);

  const unread = items.filter((i) => !i.read_at).length;

  async function clickItem(n: Notification) {
    if (!n.read_at) {
      setItems((prev) =>
        prev.map((p) =>
          p.id === n.id ? { ...p, read_at: new Date().toISOString() } : p,
        ),
      );
      try {
        await markNotificationRead(n.id);
      } catch {
        load();
      }
    }
    setOpen(false);
    if (n.link) router.push(n.link);
  }

  async function markAll() {
    const now = new Date().toISOString();
    setItems((prev) => prev.map((p) => ({ ...p, read_at: p.read_at ?? now })));
    try {
      await markAllNotificationsRead();
    } catch (err) {
      console.error("[notification-bell] markAll failed", err);
      load();
    }
  }

  const dropdown = open && pos && (
    <div
      ref={dropdownRef}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        right: pos.right,
      }}
      className="z-[60] max-w-[calc(100vw-1.5rem)] w-[22rem] overflow-hidden rounded-2xl border border-line bg-paper"
    >
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-xs font-mono font-semibold uppercase tracking-wider text-ink-faint">
              Notifications
            </p>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAll}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-phosphor-ink transition hover:opacity-80"
              >
                <CheckCheck className="h-3 w-3" /> Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-[26rem] divide-y divide-line overflow-y-auto">
            {loading && items.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-ink-faint">
                Loading…
              </li>
            )}
            {!loading && items.length === 0 && (
              <li className="px-4 py-10 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-line bg-wash">
                  <Bell className="h-4 w-4 text-ink-faint" />
                </div>
                <p className="mt-3 text-sm text-ink-soft">No notifications</p>
                <p className="mt-0.5 text-xs text-ink-faint">
                  You&apos;re all caught up.
                </p>
              </li>
            )}
            {items.map((n) => {
              const isUnread = !n.read_at;
              return (
                <li key={n.id} className="relative">
                  {isUnread && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-0 h-full w-[2px] bg-phosphor"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => clickItem(n)}
                    className="press block w-full px-4 py-3 text-left hover:bg-wash"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p
                        className={`min-w-0 flex-1 break-words line-clamp-2 text-sm leading-snug ${
                          isUnread
                            ? "font-medium text-ink"
                            : "font-normal text-ink-soft"
                        }`}
                      >
                        {n.title}
                      </p>
                      <p
                        className={`shrink-0 pt-0.5 text-[10px] font-mono tabular-nums ${
                          isUnread ? "text-ink-soft" : "text-ink-faint"
                        }`}
                      >
                        {formatRelativeTime(n.created_at)}
                      </p>
                    </div>
                    {n.body && (
                      <p
                        className={`mt-1 line-clamp-2 break-words text-xs ${
                          isUnread ? "text-ink-soft" : "text-ink-faint"
                        }`}
                      >
                        {n.body}
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-line bg-wash px-4 py-2.5">
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-ink-soft transition hover:text-ink"
            >
              View all →
            </Link>
          </div>
        </div>
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={
          unread > 0 ? `Notifications (${unread} unread)` : "Notifications"
        }
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-9 w-9 items-center justify-center rounded-md border border-line text-ink-soft transition hover:bg-wash hover:text-ink"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-phosphor px-1 text-[10px] font-bold leading-none text-on-phosphor">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {mounted && dropdown && createPortal(dropdown, document.body)}
    </>
  );
}
