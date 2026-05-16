import { requireUser, getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { CheckinForm } from "./checkin-form";
import { isoWeekStart, formatWeekRange } from "@/lib/week";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";

export const metadata = { title: "Weekly check-in · SparkLine Youth" };

export default async function CheckinPage() {
  const user = await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");
  if (!access.enrolled) {
    return (
      <LockedFeature
        title="Weekly check-in"
        applicationStatus={access.applicationStatus}
      />
    );
  }
  const supabase = createClient();
  const weekStart = isoWeekStart();

  const { data: current } = await supabase
    .from("student_checkins")
    .select("id, week_start, accomplished, next_up, blockers, is_milestone, updated_at")
    .eq("user_id", user.id)
    .eq("week_start", weekStart)
    .maybeSingle();

  const { data: history } = await supabase
    .from("student_checkins")
    .select("id, week_start, accomplished, next_up, blockers, updated_at")
    .eq("user_id", user.id)
    .neq("week_start", weekStart)
    .order("week_start", { ascending: false })
    .limit(8);

  // Feedback for current + prior weeks in one shot.
  const ids = [current?.id, ...((history ?? []).map((h: any) => h.id))]
    .filter(Boolean) as string[];
  const { data: feedbackRows } = ids.length
    ? await supabase
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
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Weekly check-in</h1>
      <p className="mt-1 text-sm text-white/55">
        Take five minutes each week to share progress and roadblocks. Your
        mentor and the admin team see this and can leave feedback.
      </p>

      <Card className="mt-6">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
            This week
          </h2>
          <span className="text-xs text-white/45">
            {formatWeekRange(weekStart)}
          </span>
        </div>
        <CheckinForm
          initial={{
            accomplished: current?.accomplished ?? "",
            next_up: current?.next_up ?? "",
            blockers: current?.blockers ?? "",
            is_milestone: (current as any)?.is_milestone ?? false,
          }}
        />
        {current && (feedbackByCheckin.get(current.id) ?? []).length > 0 && (
          <FeedbackList
            items={feedbackByCheckin.get(current.id) ?? []}
            label="Mentor feedback"
          />
        )}
      </Card>

      {(history?.length ?? 0) > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/55">
            History
          </h2>
          <div className="space-y-4">
            {(history ?? []).map((h: any) => (
              <Card key={h.id}>
                <div className="flex items-baseline justify-between">
                  <h3 className="text-base font-semibold">
                    {formatWeekRange(h.week_start)}
                  </h3>
                  <span className="text-xs text-white/40">
                    Saved <LocalTime value={h.updated_at} mode="date" />
                  </span>
                </div>
                <ReadOnlyField label="Accomplished" value={h.accomplished} />
                <ReadOnlyField label="Next up" value={h.next_up} />
                <ReadOnlyField label="Blockers" value={h.blockers} />
                {(feedbackByCheckin.get(h.id) ?? []).length > 0 && (
                  <FeedbackList
                    items={feedbackByCheckin.get(h.id) ?? []}
                    label="Mentor feedback"
                  />
                )}
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
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
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-white/80 [overflow-wrap:anywhere]">
        {value}
      </p>
    </div>
  );
}

function FeedbackList({
  items,
  label,
}: {
  items: any[];
  label: string;
}) {
  return (
    <div className="mt-5 border-t border-white/10 pt-4">
      <div className="mb-2 text-xs uppercase tracking-wider text-spark">
        {label}
      </div>
      <ul className="space-y-3">
        {items.map((f) => {
          const author = Array.isArray(f.author) ? f.author[0] : f.author;
          return (
            <li
              key={f.id}
              className="rounded-lg border border-white/10 bg-black/30 p-3"
            >
              <div className="flex items-baseline justify-between text-xs text-white/45">
                <span>{author?.full_name ?? author?.email ?? "Mentor"}</span>
                <span><LocalTime value={f.created_at} /></span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-white/85 break-words [overflow-wrap:anywhere]">
                {f.body}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
