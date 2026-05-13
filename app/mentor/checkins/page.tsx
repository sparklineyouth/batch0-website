import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { CheckinFeedbackForm } from "./feedback-form";
import { isoWeekStart, formatWeekRange } from "@/lib/week";

export const metadata = { title: "Check-ins · Mentor" };

export default async function MentorCheckinsPage({
  searchParams,
}: {
  searchParams: { week?: string; cohort?: string };
}) {
  const admin = createAdminClient();
  const week = searchParams.week || isoWeekStart();
  const cohortFilter = searchParams.cohort ?? "all";

  const [{ data: cohorts }, { data: weeks }] = await Promise.all([
    admin.from("cohorts").select("id, name").order("starts_on"),
    admin
      .from("student_checkins")
      .select("week_start")
      .order("week_start", { ascending: false }),
  ]);

  // Distinct weeks for the picker. Falls back to "this week" if there's
  // no data yet.
  const weekOptions = Array.from(
    new Set([
      isoWeekStart(),
      ...(weeks ?? []).map((w: any) => w.week_start),
    ]),
  );

  let q = admin
    .from("student_checkins")
    .select(
      "id, week_start, accomplished, next_up, blockers, updated_at, user:profiles!student_checkins_user_id_fkey(id, email, full_name), cohort:cohorts(name, id)",
    )
    .eq("week_start", week)
    .order("updated_at", { ascending: false });
  if (cohortFilter !== "all") q = q.eq("cohort_id", cohortFilter);
  const { data: checkins } = await q;

  const ids = (checkins ?? []).map((c: any) => c.id);
  const { data: feedbackRows } = ids.length
    ? await admin
        .from("checkin_feedback")
        .select(
          "id, checkin_id, body, created_at, author:profiles(full_name, email)",
        )
        .in("checkin_id", ids)
        .order("created_at", { ascending: true })
    : { data: [] };
  const feedbackByCheckin = new Map<string, any[]>();
  for (const f of (feedbackRows ?? []) as any[]) {
    const arr = feedbackByCheckin.get(f.checkin_id) ?? [];
    arr.push(f);
    feedbackByCheckin.set(f.checkin_id, arr);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight">Weekly check-ins</h1>
      <p className="mt-1 text-sm text-white/55">
        Read what students said this week. Drop a quick reply — they get a
        notification.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-white/40">
          Week
        </span>
        <div className="flex flex-wrap gap-2">
          {weekOptions.map((w) => (
            <Pill
              key={w}
              href={`/mentor/checkins?week=${w}${cohortFilter !== "all" ? `&cohort=${cohortFilter}` : ""}`}
              label={formatWeekRange(w)}
              active={w === week}
            />
          ))}
        </div>
        <span className="ml-4 text-xs uppercase tracking-wider text-white/40">
          Cohort
        </span>
        <Pill
          href={`/mentor/checkins?week=${week}`}
          label="All"
          active={cohortFilter === "all"}
        />
        {(cohorts ?? []).map((c: any) => (
          <Pill
            key={c.id}
            href={`/mentor/checkins?week=${week}&cohort=${c.id}`}
            label={c.name}
            active={cohortFilter === c.id}
          />
        ))}
      </div>

      <div className="mt-6 space-y-4">
        {(checkins?.length ?? 0) === 0 ? (
          <Card>
            <p className="text-sm text-white/55">
              No check-ins for {formatWeekRange(week)} yet.
            </p>
          </Card>
        ) : (
          (checkins ?? []).map((c: any) => {
            const user = Array.isArray(c.user) ? c.user[0] : c.user;
            const cohort = Array.isArray(c.cohort) ? c.cohort[0] : c.cohort;
            return (
              <Card key={c.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h3 className="text-base font-semibold text-white">
                      {user?.full_name ?? user?.email ?? "—"}
                    </h3>
                    <p className="text-xs text-white/45">
                      {cohort?.name ?? "Unassigned cohort"} · Saved{" "}
                      <LocalTime value={c.updated_at} />
                    </p>
                  </div>
                </div>
                <ReadOnlyField label="Accomplished" value={c.accomplished} />
                <ReadOnlyField label="Next up" value={c.next_up} />
                <ReadOnlyField label="Blockers" value={c.blockers} />

                {(feedbackByCheckin.get(c.id) ?? []).length > 0 && (
                  <div className="mt-5 border-t border-white/10 pt-4">
                    <div className="mb-2 text-xs uppercase tracking-wider text-spark">
                      Feedback so far
                    </div>
                    <ul className="space-y-2">
                      {(feedbackByCheckin.get(c.id) ?? []).map((f: any) => {
                        const author = Array.isArray(f.author)
                          ? f.author[0]
                          : f.author;
                        return (
                          <li
                            key={f.id}
                            className="rounded-lg border border-white/10 bg-black/30 p-3"
                          >
                            <div className="flex items-baseline justify-between text-xs text-white/45">
                              <span>
                                {author?.full_name ?? author?.email ?? "Mentor"}
                              </span>
                              <span>
                                <LocalTime value={f.created_at} />
                              </span>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap text-sm text-white/85 break-words [overflow-wrap:anywhere]">
                              {f.body}
                            </p>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                <CheckinFeedbackForm checkinId={c.id} />
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

function Pill({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
        active
          ? "border-spark bg-spark/10 text-spark"
          : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
      }`}
    >
      {label}
    </Link>
  );
}

function ReadOnlyField({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  if (!value) return null;
  return (
    <div className="mt-4">
      <div className="text-xs uppercase tracking-wider text-white/40">
        {label}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-white/85 [overflow-wrap:anywhere]">
        {value}
      </p>
    </div>
  );
}
