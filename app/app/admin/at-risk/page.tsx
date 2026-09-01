import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { LocalTime } from "@/components/ui/local-time";
import { isoWeekStart, lastNWeeks } from "@/lib/week";
import { AppHeader, AppBody, Row, Empty } from "@/components/app/frame";
import { DotRail, type RailCell } from "@/components/app/viz";
import { ResolveButton } from "@/app/admin/interventions/resolve-button";

export const metadata = { title: "At-risk · Admin" };
export const dynamic = "force-dynamic";

/** The desktop list takes 200 rows in one shot with no pager. A phone queue you
 *  work one student at a time does not need 200 — and a screen that silently
 *  stops at a number is worse than one that says where the rest are. */
const PAGE_SIZE = 25;
/** Weeks of check-in history behind each flag. Eight is two months: long enough
 *  to tell "never started" from "was fine until October". */
const WEEKS = 8;

function embed<T>(value: unknown): T | null {
  if (!value) return null;
  return (Array.isArray(value) ? value[0] : value) as T;
}

/**
 * The at-risk queue.
 *
 * Open flags only. The desktop page also lists the last 30 resolved ones, which
 * is a record rather than work — the same reason the Review screen shows no
 * decided applications. What resolving earns you here is the count in the
 * eyebrow, and then the row is gone.
 *
 * Oldest first, which inverts the desktop order. The newest flag is the one the
 * Monday cron just raised and nobody has had a chance to work; the oldest is the
 * one that has been sitting through every Monday since. On a screen capped at 25
 * the top of the list should be the failure, not the news.
 *
 * Each row carries the student's own check-in cadence, because "flagged" alone
 * cannot distinguish a student who has never checked in from one who stopped
 * three weeks ago, and those are different conversations.
 */
export default async function AdminAppAtRisk() {
  const { caps } = await requirePermission("interventions.manage");
  const admin = createAdminClient();
  const weeks = lastNWeeks(WEEKS);
  const thisWeek = weeks[weeks.length - 1].key;

  const [openRes, clearedRes] = await Promise.all([
    admin
      .from("at_risk_interventions")
      .select(
        "id, missed_weeks, reason, created_at, week_start, student:profiles(id, full_name, email)",
        { count: "exact" },
      )
      .is("resolved_at", null)
      .order("created_at", { ascending: true })
      .limit(PAGE_SIZE),
    // The reward loop: what this week's outreach has already cleared.
    admin
      .from("at_risk_interventions")
      .select("id", { count: "exact", head: true })
      .not("resolved_at", "is", null)
      .gte("resolved_at", weeks[weeks.length - 1].start.toISOString()),
  ]);

  const flags = (openRes.data ?? []) as {
    id: string;
    missed_weeks: number | null;
    reason: string | null;
    created_at: string;
    student: unknown;
  }[];
  const rows = flags.map((f) => ({
    ...f,
    student: embed<{ id: string; full_name: string | null; email: string | null }>(
      f.student,
    ),
  }));

  // Second wave, not part of the batch above: it is keyed on the student ids
  // the first query returns, so it cannot start any earlier. One query for the
  // whole page rather than one per row.
  const studentIds = rows.map((r) => r.student?.id).filter(Boolean) as string[];
  const { data: checkins } = studentIds.length
    ? await admin
        .from("student_checkins")
        .select("user_id, week_start")
        .in("user_id", studentIds)
        .gte("week_start", weeks[0].key)
    : { data: null };

  // The window is generated from the calendar and then marked, per DotRail's
  // contract: a `.gte("week_start", …)` read returns rows only for weeks that
  // HAVE a check-in, so an absent week comes back as a missing row rather than
  // as a false value. Bucketing the results alone would draw a two-cell rail
  // for a student who checked in twice and call it eight weeks.
  const hits = new Set<string>();
  for (const c of (checkins ?? []) as { user_id: string; week_start: string }[]) {
    // Re-derived rather than trusted. `week_start` is a bare `date` column that
    // is Monday-aligned by convention, and a row that is off by a day would
    // otherwise match no cell and read as a missed week.
    const key = isoWeekStart(new Date(`${c.week_start}T00:00:00Z`));
    hits.add(`${c.user_id}|${key}`);
  }

  const open = openRes.count ?? rows.length;
  const cleared = clearedRes.count ?? 0;
  const seePeople = can(caps, "people.view");

  return (
    <>
      <AppHeader
        title="At risk"
        eyebrow={
          openRes.error
            ? "Couldn't load the queue"
            : open === 0
              ? "Nobody flagged"
              : `${open} open${cleared > 0 ? ` · ${cleared} cleared this week` : ""}`
        }
      />
      <AppBody>
        <p className="text-[13px] leading-relaxed text-ink-soft">
          Raised by the Monday cron after two straight weeks without a check-in.
          Resolve once you have actually reached out.
        </p>

        <div className="mt-5 space-y-2.5">
          {rows.length === 0 ? (
            // A failed read and an empty queue produce the same zero rows and
            // mean opposite things. Telling an admin there is no work when the
            // query errored is the one wrong answer this screen can give, and
            // the eyebrow's warning is no use if the box under it contradicts
            // it in a full sentence.
            <Empty>
              {openRes.error
                ? "The queue didn't load, so this is empty for the wrong reason. Reload, or open the full queue at /admin/interventions."
                : "Nobody is drifting right now."}
            </Empty>
          ) : (
            rows.map((r) => {
              const name =
                r.student?.full_name || r.student?.email || "Student";
              const cells: RailCell[] = weeks.map((w) => ({
                key: w.key,
                label: w.label,
                state: hits.has(`${r.student?.id}|${w.key}`)
                  ? "hit"
                  : // The running week is not a miss yet — its check-in is
                    // still due. Marking it one would put a permanent gap on
                    // the right of every rail in the list.
                    w.key === thisWeek
                    ? "future"
                    : "miss",
              }));
              const lastHit = [...weeks]
                .reverse()
                .find((w) => hits.has(`${r.student?.id}|${w.key}`));

              return (
                <div key={r.id} className="rounded-2xl border border-line px-4">
                  {/* The whole row is the navigation, and the only thing on
                      this line. The desktop puts a bare 16px "Open →" link
                      beside a 32px Resolve button — two different-sized
                      targets, one of them a state change, inside a thumb's
                      width of each other. Here they are on separate lines,
                      split by the row's own bottom border. */}
                  <Row
                    label={name}
                    value={r.reason ?? undefined}
                    meta={
                      <>
                        {r.missed_weeks ?? 0} week
                        {(r.missed_weeks ?? 0) === 1 ? "" : "s"} missed · flagged{" "}
                        <LocalTime value={r.created_at} mode="date" />
                      </>
                    }
                    below={
                      <DotRail
                        label={`${name}'s check-ins, last ${WEEKS} weeks`}
                        cells={cells}
                        caption={
                          lastHit
                            ? `Last check-in ${lastHit.label}`
                            : `No check-in in ${WEEKS} weeks`
                        }
                      />
                    }
                    // /app/admin/people/[id] requires people.view, so a role
                    // that can work this queue but not open a person gets a
                    // non-navigating row rather than a redirect back to its
                    // own home screen.
                    href={
                      seePeople && r.student?.id
                        ? `/app/admin/people/${r.student.id}`
                        : undefined
                    }
                    // Same call /app/admin/people makes for the same
                    // destination: it is force-dynamic behind this segment's
                    // shared loading.tsx, so every prefetch returns the one
                    // identical static shell. On a queue of 25 thumb-scrolled
                    // rows that is 25 requests that buy nothing.
                    prefetch={false}
                  />
                  <div className="flex items-center justify-end py-2.5">
                    {/* min-h/min-w on the child rather than a restyle: the
                        shared Button ships `sm` at 32px, and min-height beats
                        height in the box model regardless of which utility the
                        stylesheet emits last. Same trick, and same reason, as
                        AppHeader's action slot. */}
                    <div className="[&>button]:min-h-11 [&>button]:min-w-[6rem]">
                      <ResolveButton id={r.id} />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {open > rows.length && (
          <p className="mt-5 text-center text-[12px] leading-relaxed text-ink-faint">
            Showing the {rows.length} longest-open. {open - rows.length} more are
            waiting —{" "}
            <Link
              href="/admin/interventions"
              prefetch={false}
              className="text-phosphor-ink underline"
            >
              the full queue
            </Link>{" "}
            has all of them.
          </p>
        )}
      </AppBody>
    </>
  );
}
