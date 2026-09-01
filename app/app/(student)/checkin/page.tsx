import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { isoWeekStart, formatWeekRange, lastNWeeks } from "@/lib/week";
import { fmtDateOnly } from "@/lib/pre-cohort";
import { LocalTime } from "@/components/ui/local-time";
import { AppHeader, AppBody, Section, Alert } from "@/components/app/frame";
import { DotRail } from "@/components/app/viz";
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
  // The window the rail is drawn over. Twelve weeks, not the home screen's
  // eight: this is the screen you are on *because* of check-ins, so it can
  // afford a full quarter. Twelve cells across a 280px body is ~20px each,
  // which is still a readable pattern.
  const railWeeks = lastNWeeks(12);

  // One query, not two, for this week. Feedback hangs off the check-in row, so
  // fetching it separately meant waiting for that row's id to come back before
  // the second request could even be issued — a full serial round trip for a
  // nested list. PostgREST resolves the whole tree in one hop.
  //
  // The `profiles` embed is unqualified, matching /mentor/checkins: there is
  // exactly one FK from checkin_feedback to profiles, so no constraint hint is
  // needed.
  const [
    { data: checkin },
    { data: history, error: historyError },
  ] = await Promise.all([
    admin
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
      .maybeSingle(),
    // A second, deliberately narrow read rather than widening the one above.
    // `accomplished`, `next_up` and `blockers` are capped at 4000 characters
    // each, so twelve rows of the full shape is up to ~140KB of prose fetched
    // to draw twelve squares. Two columns is a few hundred bytes, and it rides
    // in the same wave, so the history costs no extra latency.
    admin
      .from("student_checkins")
      .select("week_start, is_milestone")
      .eq("user_id", profile.id)
      .gte("week_start", railWeeks[0].key)
      .order("week_start", { ascending: true })
      .limit(12),
  ]);

  // The rail is built from the calendar and then marked, never from the rows:
  // `.gte()` returns rows only for the weeks that HAVE a check-in, so a skipped
  // week comes back as a missing row rather than as a false value. Mapping the
  // results straight through would draw a short rail that reads as a young
  // history instead of the gappy one it actually is.
  const posted = new Map<string, boolean>(
    (history ?? []).map((h) => [h.week_start as string, !!h.is_milestone]),
  );
  const railCells = railWeeks.map((w) => ({
    key: w.key,
    label: w.label,
    // The current week is not a miss until it is over. It renders as the open
    // cell at the end, and DotRail leaves "future" cells out of its count, so
    // an unposted Monday never reads as a broken streak.
    state: posted.has(w.key)
      ? ("hit" as const)
      : w.key === weekStart
        ? ("future" as const)
        : ("miss" as const),
  }));

  // The caption complements the rail's own summary rather than repeating it —
  // DotRail already says "9 of 11, missed Aug 4". Streak and milestones are the
  // two things the squares cannot show.
  const milestones = [...posted.values()].filter(Boolean).length;
  let streak = 0;
  for (let i = railCells.length - 1; i >= 0; i--) {
    if (railCells[i].state === "future") continue; // open week, neither way
    if (railCells[i].state !== "hit") break;
    streak += 1;
  }
  const railCaption =
    streak > 0
      ? `${streak}-week streak${
          milestones
            ? ` · ${milestones} milestone${milestones === 1 ? "" : "s"}`
            : ""
        }`
      : posted.size === 0
        ? "Nothing on the rail yet. This week starts it."
        : "Streak broken. This week starts a new one.";

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
        {/* Above the form, not under it. The question this screen actually
            asks is "am I keeping this up", and seeing the gaps is what makes
            writing the next one feel worth the five minutes.

            Suppressed outright if the history read failed, rather than drawn
            from `history ?? []`. A failed query and a student who has never
            posted produce the identical empty map, and the rail's whole
            vocabulary is absence — so the error case renders as twelve missed
            weeks and tells someone with a perfect record that they have never
            checked in. An absent chart is a smaller lie than a wrong one. */}
        {!historyError && (
          <Section title="Last 12 weeks">
            <DotRail
              label="Weekly check-ins"
              cells={railCells}
              caption={railCaption}
            />
          </Section>
        )}

        {/* The section rhythm, unless the rail above it is gone — Section
            carries `first:mt-0` for exactly this and a bare div does not. */}
        <div className={historyError ? "" : "mt-10"}>
          <CheckinForm
            weekLabel={weekLabel}
            weekStart={weekStart}
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
        </div>

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
