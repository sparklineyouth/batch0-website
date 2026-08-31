import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { isoWeekStart, formatWeekRange } from "@/lib/week";
import { fmtDateOnly } from "@/lib/pre-cohort";
import { LocalTime } from "@/components/ui/local-time";
import { AppHeader, AppBody, Section, Alert } from "@/components/app/frame";
import { CheckinForm } from "./checkin-form";
import type { Role } from "@/lib/types";

export const metadata = { title: "Check-in · batch0" };
export const dynamic = "force-dynamic";

/**
 * The weekly check-in.
 *
 * This is the one thing on the student side that is genuinely BETTER on a phone
 * than at a desk — it's three short answers, it's due on a Sunday night, and the
 * moment you remember you owe one is rarely the moment you're at a laptop. It
 * gets its own tab for that reason and no other.
 *
 * Mentor feedback on the current week renders under the form: a student who
 * opens this to write is also the student who hasn't seen the reply to last
 * week's, and it costs one query.
 */
export default async function StudentAppCheckin() {
  const { profile } = await requireViewer();
  const access = await getStudentAccess(profile.role as Role);

  if (!access.enrolled || access.preCohort) {
    const startLabel = fmtDateOnly(access.cohortStartsOn);
    return (
      <>
        <AppHeader title="Check-in" eyebrow="Locked" />
        <AppBody>
          <Alert tone="info" title="Check-ins open when your cohort starts.">
            Every week you'll post what you shipped, what's next, and what's
            blocking you
            {startLabel ? ` — starting ${startLabel}` : ""}.
          </Alert>
        </AppBody>
      </>
    );
  }

  const admin = createAdminClient();
  const weekStart = isoWeekStart();
  // One query, not two. Feedback hangs off the check-in row, so fetching it
  // separately meant waiting for that row's id to come back before the second
  // request could even be issued — a full serial round trip for a nested list.
  // PostgREST resolves the whole tree in one hop.
  //
  // The `profiles` embed is unqualified, matching /mentor/checkins: there is
  // exactly one FK from checkin_feedback to profiles, so no constraint hint is
  // needed.
  const { data: checkin } = await admin
    .from("student_checkins")
    .select(
      "id, accomplished, next_up, blockers, is_milestone, updated_at, checkin_feedback(id, body, created_at, author:profiles(full_name))",
    )
    .eq("user_id", profile.id)
    .eq("week_start", weekStart)
    .order("created_at", {
      ascending: true,
      referencedTable: "checkin_feedback",
    })
    .maybeSingle();

  const feedback = (checkin?.checkin_feedback ?? []) as Array<{
    id: string;
    body: string;
    created_at: string;
    author?: unknown;
  }>;

  const weekLabel = formatWeekRange(weekStart);

  return (
    <>
      <AppHeader
        title="Check-in"
        eyebrow={weekLabel}
        action={
          checkin ? (
            <span className="shrink-0 rounded-full bg-emerald-500/15 px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
              Posted
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-amber-500/15 px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
              Due
            </span>
          )
        }
      />
      <AppBody>
        <CheckinForm
          weekLabel={weekLabel}
          initial={
            checkin
              ? {
                  accomplished: checkin.accomplished ?? "",
                  next_up: checkin.next_up ?? "",
                  blockers: checkin.blockers ?? "",
                  is_milestone: !!checkin.is_milestone,
                }
              : null
          }
        />

        {(feedback ?? []).length > 0 && (
          <Section title="Feedback on this week">
            <div className="space-y-2.5">
              {(feedback ?? []).map((f) => {
                const author = normalizeEmbed<{ full_name: string | null }>(
                  (f as { author?: unknown }).author,
                );
                return (
                  <div
                    key={f.id as string}
                    className="rounded-2xl border border-line bg-wash px-5 py-4"
                  >
                    <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">
                      {f.body as string}
                    </p>
                    <p className="mt-2 font-mono text-[11px] tabular-nums text-ink-faint">
                      {author?.full_name ?? "Mentor"} ·{" "}
                      <LocalTime
                        value={f.created_at as string}
                        mode="datetime-short"
                      />
                    </p>
                  </div>
                );
              })}
            </div>
          </Section>
        )}
      </AppBody>
    </>
  );
}

function normalizeEmbed<T>(value: unknown): T | null {
  if (!value) return null;
  return (Array.isArray(value) ? (value[0] ?? null) : value) as T | null;
}
