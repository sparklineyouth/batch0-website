import Link from "next/link";
import { ArrowLeft, Bell } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile, roleHome } from "@/lib/auth";
import { MarkAllRead } from "./mark-all-read";
import { NotificationItem } from "./notification-item";

export const metadata = { title: "Notifications · Sparkline Youth" };

export default async function NotificationsPage() {
  const user = await requireUser();
  const profile = await getProfile();
  const home = roleHome(profile?.role ?? "student");

  const supabase = createClient();
  const { data: items } = await supabase
    .from("notifications")
    .select("id, type, title, body, link, read_at, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(200);

  const all = items ?? [];
  const unread = all.filter((i) => !i.read_at);
  const read = all.filter((i) => i.read_at);

  return (
    <div className="min-h-screen bg-paper text-ink">
      <div className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4 md:px-8">
          <Link
            href={home}
            className="press inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
          {unread.length > 0 && <MarkAllRead />}
        </div>
      </div>

      <main className="mx-auto max-w-3xl px-5 py-10 md:px-8 md:py-14">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-spark-ink">
              Inbox
            </p>
            <h1 className="mt-2 font-display text-3xl md:text-4xl font-bold tracking-[-0.02em] text-ink">
              Notifications
            </h1>
          </div>
          <p className="shrink-0 text-sm text-ink-soft">
            {unread.length > 0
              ? `${unread.length} unread`
              : "All caught up"}
          </p>
        </div>

        {all.length === 0 ? (
          <div className="mt-12 rounded-2xl border border-line bg-wash px-6 py-14 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-line">
              <Bell className="h-4 w-4 text-ink-faint" />
            </div>
            <p className="mt-4 text-sm text-ink-soft">No notifications yet.</p>
            <p className="mt-1 text-xs text-ink-faint">
              You&apos;ll see updates here when there&apos;s activity on your
              account.
            </p>
          </div>
        ) : (
          <div className="mt-10 space-y-10">
            {unread.length > 0 && (
              <section>
                <h2 className="mb-4 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-faint">
                  Unread
                </h2>
                <ul className="divide-y divide-line border-y border-line">
                  {unread.map((n) => (
                    <NotificationItem key={n.id} n={n as any} />
                  ))}
                </ul>
              </section>
            )}
            {read.length > 0 && (
              <section>
                <h2 className="mb-4 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-faint">
                  Earlier
                </h2>
                <ul className="divide-y divide-line border-y border-line">
                  {read.map((n) => (
                    <NotificationItem key={n.id} n={n as any} />
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
