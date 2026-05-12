"use client";
import { useEffect, useRef, useState } from "react";
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
  const containerRef = useRef<HTMLDivElement>(null);

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
      channel = supabase
        .channel(`notif-${user.id}`)
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
    })();

    // Safety net: re-sync once a minute in case a Realtime event was missed.
    const safety = setInterval(load, 60_000);

    return () => {
      cancelled = true;
      clearInterval(safety);
      if (channel) channel.unsubscribe();
    };
  }, []);

  // Refresh when reopening so we don't miss anything that arrived
  // while the dropdown was closed (covers Realtime drops on weak connections).
  useEffect(() => {
    if (open) load();
  }, [open]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
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

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={
          unread > 0 ? `Notifications (${unread} unread)` : "Notifications"
        }
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-white/70 transition hover:bg-white/5 hover:text-white"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-spark px-1 text-[10px] font-bold leading-none text-black">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className={`absolute z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-white/10 bg-zinc-950 shadow-[0_30px_60px_-15px_rgba(0,0,0,0.7)] ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/50">
              Notifications
            </p>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAll}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-spark transition hover:text-spark-200"
              >
                <CheckCheck className="h-3 w-3" /> Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-[26rem] divide-y divide-white/5 overflow-y-auto">
            {loading && items.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-white/40">
                Loading…
              </li>
            )}
            {!loading && items.length === 0 && (
              <li className="px-4 py-10 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-zinc-900/60">
                  <Bell className="h-4 w-4 text-white/30" />
                </div>
                <p className="mt-3 text-sm text-white/50">No notifications</p>
                <p className="mt-0.5 text-xs text-white/30">
                  You&apos;re all caught up.
                </p>
              </li>
            )}
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => clickItem(n)}
                  className={`block w-full px-4 py-3 text-left transition hover:bg-white/[0.03] ${
                    n.read_at ? "opacity-60" : ""
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <span
                      className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                        n.read_at ? "bg-transparent" : "bg-spark"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-white">
                        {n.title}
                      </div>
                      {n.body && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-white/55">
                          {n.body}
                        </p>
                      )}
                      <p className="mt-1 text-[10px] uppercase tracking-wider text-white/30">
                        {formatRelativeTime(n.created_at)}
                      </p>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-white/10 bg-black/40 px-4 py-2.5">
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-white/60 transition hover:text-white"
            >
              View all →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
