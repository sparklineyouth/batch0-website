import Link from "next/link";
import { ArrowLeft, Bell } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile, roleHome } from "@/lib/auth";
import { MarkAllRead } from "./mark-all-read";
import { NotificationItem } from "./notification-item";
import { getThemeFromCookie } from "@/lib/theme";

export const metadata = { title: "Notifications · SparkLine Youth" };

export default async function NotificationsPage() {
  const user = await requireUser();
  const profile = await getProfile();
  const home = roleHome(profile?.role ?? "student");
  const themeClass =
    getThemeFromCookie() === "light" ? "theme-light" : "";

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
    <div className={`${themeClass} min-h-screen bg-black text-white`}>
      <div className="border-b border-white/10">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4 md:px-8">
          <Link
            href={home}
            className="press inline-flex items-center gap-1.5 text-sm text-white/65 hover:text-white"
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
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-spark">
              Inbox
            </p>
            <h1 className="mt-2 text-3xl md:text-4xl font-bold tracking-[-0.02em]">
              Notifications
            </h1>
          </div>
          <p className="shrink-0 text-sm text-white/60">
            {unread.length > 0
              ? `${unread.length} unread`
              : "All caught up"}
          </p>
        </div>

        {all.length === 0 ? (
          <div className="mt-12 rounded-xl border border-white/10 bg-white/[0.02] px-6 py-14 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-white/10">
              <Bell className="h-4 w-4 text-white/40" />
            </div>
            <p className="mt-4 text-sm text-white/75">No notifications yet.</p>
            <p className="mt-1 text-xs text-white/50">
              You&apos;ll see updates here when there&apos;s activity on your
              account.
            </p>
          </div>
        ) : (
          <div className="mt-10 space-y-10">
            {unread.length > 0 && (
              <section>
                <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/45">
                  Unread
                </h2>
                <ul className="divide-y divide-white/10 border-y border-white/10">
                  {unread.map((n) => (
                    <NotificationItem key={n.id} n={n as any} />
                  ))}
                </ul>
              </section>
            )}
            {read.length > 0 && (
              <section>
                <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/45">
                  Earlier
                </h2>
                <ul className="divide-y divide-white/10 border-y border-white/10">
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
