import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, getProfile } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { Megaphone } from "lucide-react";
import { Reactions } from "./reactions";
import { EMOJIS, type Emoji } from "./emoji";

export const metadata = { title: "Announcements · SparkLine Youth" };
export const dynamic = "force-dynamic";

export default async function AnnouncementsPage() {
  const user = await requireUser();
  const profile = await getProfile();
  const supabase = createClient();

  // RLS already gates which announcements the user can read; this
  // query intentionally has no .eq("cohort_id", ...) so admin sees all
  // and a student sees their cohort's + global ones.
  const { data: anns, error } = await supabase
    .from("announcements")
    .select(
      "id, cohort_id, title, body, created_at, cohort:cohorts(name, cohort_number)",
    )
    .order("created_at", { ascending: false })
    .limit(50);

  // Pre-0027 deployments: gracefully fall back to an empty state with a
  // setup hint instead of crashing the dashboard.
  if (error && /relation .*announcements.* does not exist/i.test(error.message)) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight">Announcements</h1>
        <Card className="mt-6">
          <p className="text-sm text-white/55">
            Announcements aren't enabled yet — apply migration{" "}
            <code className="font-mono text-spark">
              0027_announcements_and_reactions.sql
            </code>
            .
          </p>
        </Card>
      </div>
    );
  }

  const announcementIds = (anns ?? []).map((a: any) => a.id);
  const { data: allReactions } = announcementIds.length
    ? await supabase
        .from("announcement_reactions")
        .select("announcement_id, user_id, emoji")
        .in("announcement_id", announcementIds)
    : { data: [] as any[] };

  // Index reactions per-announcement so the render loop is O(1) per ann.
  type CountsByEmoji = Record<Emoji, number>;
  function emptyCounts(): CountsByEmoji {
    return EMOJIS.reduce((acc, e) => ({ ...acc, [e]: 0 }), {} as CountsByEmoji);
  }
  const countsByAnn = new Map<string, CountsByEmoji>();
  const mineByAnn = new Map<string, Set<Emoji>>();
  for (const r of (allReactions ?? []) as any[]) {
    const c = countsByAnn.get(r.announcement_id) ?? emptyCounts();
    c[r.emoji as Emoji] = (c[r.emoji as Emoji] ?? 0) + 1;
    countsByAnn.set(r.announcement_id, c);
    if (r.user_id === user.id) {
      const set = mineByAnn.get(r.announcement_id) ?? new Set<Emoji>();
      set.add(r.emoji as Emoji);
      mineByAnn.set(r.announcement_id, set);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Announcements</h1>
          <p className="mt-1 text-sm text-white/55">
            Updates from the SparkLine Youth team. React to let us know they
            landed.
          </p>
        </div>
        {profile?.role === "admin" && (
          <a
            href="/admin/announcements"
            className="text-xs text-spark hover:underline"
          >
            Send announcement →
          </a>
        )}
      </div>

      {(anns?.length ?? 0) === 0 ? (
        <Card className="mt-6 text-center">
          <Megaphone className="mx-auto h-6 w-6 text-white/30" />
          <p className="mt-3 text-sm text-white/55">
            No announcements yet. When the team posts one, it'll show up
            here.
          </p>
        </Card>
      ) : (
        <ul className="mt-6 space-y-4">
          {(anns ?? []).map((a: any) => {
            const cohort = Array.isArray(a.cohort) ? a.cohort[0] : a.cohort;
            const counts = countsByAnn.get(a.id) ?? emptyCounts();
            const mine = Array.from(mineByAnn.get(a.id) ?? []);
            return (
              <li
                id={`a-${a.id}`}
                key={a.id}
                className="scroll-mt-24 rounded-xl border border-white/10 bg-zinc-900/40 p-5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-lg font-semibold text-white">
                    {a.title}
                  </h2>
                  <span className="shrink-0 text-xs text-white/45">
                    <LocalTime value={a.created_at} mode="datetime-short" />
                  </span>
                </div>
                {cohort && (
                  <p className="mt-1 text-[11px] uppercase tracking-wider text-white/40">
                    {cohort.cohort_number != null
                      ? `Cohort ${cohort.cohort_number} · ${cohort.name}`
                      : cohort.name}
                  </p>
                )}
                <p className="mt-3 whitespace-pre-wrap break-words text-sm text-white/85">
                  {a.body}
                </p>
                <Reactions
                  announcementId={a.id}
                  initialCounts={counts}
                  initialMine={mine}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
