import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { MarkAllRead } from "./mark-all-read";

export const metadata = { title: "Notifications · SparkLine" };

export default async function NotificationsPage() {
  const user = await requireUser();
  const supabase = createClient();
  const { data: items } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(200);

  const unread = (items ?? []).filter((i: any) => !i.read_at).length;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-white/50">
            {unread > 0 ? `${unread} unread` : "All caught up."}
          </p>
        </div>
        {unread > 0 && <MarkAllRead />}
      </div>

      <div className="mt-6 space-y-2">
        {(items ?? []).length === 0 && (
          <Card>
            <p className="text-sm text-white/50">No notifications yet.</p>
          </Card>
        )}
        {(items ?? []).map((n: any) => (
          <Card
            key={n.id}
            className={`!p-0 ${n.read_at ? "opacity-70" : ""}`}
          >
            <Link
              href={n.link ?? "#"}
              className="block px-5 py-4 transition hover:bg-white/[0.02]"
            >
              <div className="flex items-start gap-3">
                {!n.read_at && (
                  <span className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-spark" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-white">{n.title}</div>
                  {n.body && (
                    <div className="mt-1 text-sm text-white/60">{n.body}</div>
                  )}
                  <div className="mt-2 text-xs text-white/40">
                    {new Date(n.created_at).toLocaleString()}
                  </div>
                </div>
              </div>
            </Link>
          </Card>
        ))}
      </div>
    </div>
  );
}
