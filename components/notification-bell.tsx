"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/app/dashboard/notifications/actions";

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch on mount + every time the dropdown opens.
  async function load() {
    const supabase = createClient();
    const { data } = await supabase
      .from("notifications")
      .select("id, type, title, body, link, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(15);
    setItems((data as Notification[]) ?? []);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", onClick);
      return () => document.removeEventListener("mousedown", onClick);
    }
  }, [open]);

  const unread = items.filter((i) => !i.read_at).length;

  async function clickItem(n: Notification) {
    if (!n.read_at) {
      try {
        await markNotificationRead(n.id);
        setItems((prev) =>
          prev.map((p) =>
            p.id === n.id ? { ...p, read_at: new Date().toISOString() } : p,
          ),
        );
      } catch {}
    }
    setOpen(false);
    if (n.link) router.push(n.link);
  }

  async function markAll() {
    try {
      await markAllNotificationsRead();
      setItems((prev) =>
        prev.map((p) => ({ ...p, read_at: p.read_at ?? new Date().toISOString() })),
      );
    } catch {}
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-white/70 hover:bg-white/5 hover:text-white"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-spark px-1 text-[10px] font-bold text-black">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-2 w-[min(20rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-white/10 bg-zinc-950 shadow-[0_30px_60px_-15px_rgba(0,0,0,0.6)]">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/50">
              Notifications
            </p>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAll}
                className="inline-flex items-center gap-1 text-[11px] text-spark hover:underline"
              >
                <CheckCheck className="h-3 w-3" /> Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-96 divide-y divide-white/5 overflow-y-auto">
            {items.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-white/40">
                Nothing yet.
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
                  <div className="flex items-start gap-2">
                    {!n.read_at && (
                      <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-spark" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-white">
                        {n.title}
                      </div>
                      {n.body && (
                        <div className="mt-0.5 text-xs text-white/60 line-clamp-2">
                          {n.body}
                        </div>
                      )}
                      <div className="mt-1 text-[10px] uppercase tracking-wider text-white/30">
                        {new Date(n.created_at).toLocaleString()}
                      </div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-white/10 bg-black/40 px-4 py-2">
            <Link
              href="/dashboard/notifications"
              onClick={() => setOpen(false)}
              className="text-xs text-white/50 hover:text-white"
            >
              View all →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
