import Link from "next/link";
import { ArrowLeft, Bell } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile, roleHome } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { MarkAllRead } from "./mark-all-read";
import { NotificationItem } from "./notification-item";

export const metadata = { title: "Notifications · SparkLine" };

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
    <div className="min-h-screen bg-black text-white">
      <header className="border-b border-white/10 bg-zinc-950/40">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4 md:px-8">
          <Link
            href={home}
            className="inline-flex items-center gap-2 text-sm text-white/60 transition hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
          {unread.length > 0 && <MarkAllRead />}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-8 md:px-8 md:py-12">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-zinc-950/60">
            <Bell className="h-4 w-4 text-spark" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
              Notifications
            </h1>
            <p className="text-sm text-white/50">
              {unread.length > 0
                ? `${unread.length} unread`
                : "You're all caught up."}
            </p>
          </div>
        </div>

        {all.length === 0 ? (
          <Card className="mt-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-zinc-950/60">
              <Bell className="h-5 w-5 text-white/40" />
            </div>
            <p className="mt-3 text-sm text-white/60">No notifications yet.</p>
            <p className="mt-1 text-xs text-white/40">
              You&apos;ll see updates here when there&apos;s activity on your account.
            </p>
          </Card>
        ) : (
          <div className="mt-8 space-y-8">
            {unread.length > 0 && (
              <section>
                <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/40">
                  Unread
                </h2>
                <ul className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/40 divide-y divide-white/5">
                  {unread.map((n) => (
                    <NotificationItem key={n.id} n={n as any} />
                  ))}
                </ul>
              </section>
            )}
            {read.length > 0 && (
              <section>
                <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/40">
                  Earlier
                </h2>
                <ul className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/40 divide-y divide-white/5">
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
