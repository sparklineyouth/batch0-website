import { requireViewer } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { LocalTime } from "@/components/ui/local-time";
import { isoWeekStart, formatWeekRange, lastNWeeks } from "@/lib/week";
import { InstallHint } from "@/components/app/install-hint";
import {
  AppHeader,
  AppBody,
  Section,
  Stat,
  Row,
  Empty,
} from "@/components/app/frame";
import { Meter, Ring, Spark } from "@/components/app/viz";

export const metadata = { title: "Admin · batch0" };
export const dynamic = "force-dynamic";

/** How many weeks the revenue trend covers. Eight, same as Pulse's series. */
const TREND_WEEKS = 8;

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/**
 * The axis-tick form of `money`. A tick gets ~31px in a 248px card, and
 * "$12,400" is seven glyphs — compact notation keeps every printed figure in
 * the Spark to four or five.
 */
function compactMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

/**
 * Application status as three mono glyphs (~40px) instead of a StatusBadge
 * (~98px for "waitlisted").
 *
 * A badge and a date together took 185px of a 246px row, which left about five
 * glyphs for the applicant's name at 320px — the name being the only reason
 * anyone taps the row. A colour dot would be smaller still, but it would encode
 * status by colour alone; the full word rides along in an sr-only span so the
 * abbreviation is never the only carrier of the meaning.
 */
const STATUS_ABBR: Record<string, string> = {
  draft: "DRF",
  submitted: "SUB",
  waitlisted: "WLT",
  accepted: "ACC",
  rejected: "REJ",
  paid: "PAY",
  enrolled: "ENR",
  withdrawn: "WDR",
};

/**
 * What needs attention, in the order it needs it.
 *
 * Every tile is gated by the same permission as the page it summarises, exactly
 * as the desktop overview is: an intern with `applications.view` and nothing
 * else must not learn the program's revenue from a phone screen that forgot to
 * check. The gate is on the query as well as the render, so an ungranted number
 * is never fetched, let alone shipped to the client and hidden with CSS.
 *
 * The check-in rate is here and not on the desktop overview because it is the
 * one number that changes the day: it says how many students are quietly
 * drifting this week, which is a thing you want to know while you still have
 * time to send a message about it.
 */
export default async function AdminAppToday() {
  const { profile, caps } = await requireViewer();
  const seeApplications = can(caps, "applications.view");
  const seePeople = can(caps, "people.view");
  const seeRevenue = can(caps, "payments.view");
  const seeAtRisk = can(caps, "interventions.manage");

  const admin = createAdminClient();
  const weekStart = isoWeekStart();
  const weeks = lastNWeeks(TREND_WEEKS);
  const windowStart = weeks[0].start.toISOString();

  const [
    { count: pending },
    { count: awaitingPayment },
    { data: enrollmentRows },
    { data: checkinRows },
    { data: activeCohorts },
    { count: atRisk },
    { data: payments },
    { data: charges },
    { data: windowPayments },
    { data: windowCharges },
    { data: recent },
  ] = await Promise.all([
    seeApplications
      ? admin
          .from("applications")
          .select("id", { count: "exact", head: true })
          .eq("status", "submitted")
      : { count: null },
    seeApplications
      ? admin
          .from("applications")
          .select("id", { count: "exact", head: true })
          .eq("status", "accepted")
      : { count: null },
    seePeople
      ? admin
          // !inner + the status filter is load-bearing: a plain count of
          // `enrollments` counts every seat ever sold, across every past
          // cohort. Dividing this week's check-ins by that made the rate fall
          // forever and read as a program collapsing rather than a stable one.
          // Scoped to cohorts actually running, it means what it says.
          //
          // Rows, not `count: exact`, because the count is the wrong number
          // twice over: it double-counts a student enrolled in two active
          // cohorts, and it gives the ratio below no way to check that a
          // check-in belongs to someone in the denominator. The ids are what
          // make both correct.
          .from("enrollments")
          .select("user_id, cohort:cohorts!inner(status)")
          .eq("cohort.status", "active")
      : { data: null },
    seePeople
      ? admin
          // Same reason: a head count here counts every check-in row for the
          // week from every cohort, including completed ones, against a
          // denominator narrowed to active cohorts — so "33/30" was reachable,
          // and a ring gauge drawn on it renders past its own maximum while the
          // warn threshold reads >100% as healthy. Filtering these ids through
          // the enrolled set is what app/admin/pulse/page.tsx already does.
          .from("student_checkins")
          .select("user_id")
          .eq("week_start", weekStart)
      : { data: null },
    // The Enrolled meter's ceiling. Summed across active cohorts because a
    // program running two at once has one roster and two capacities.
    seePeople
      ? admin.from("cohorts").select("capacity").eq("status", "active")
      : { data: null },
    seeAtRisk
      ? admin
          .from("at_risk_interventions")
          .select("id", { count: "exact", head: true })
          .is("resolved_at", null)
      : { count: null },
    // Same row-by-row sum and explicit cap as the desktop overview. Past ~10k
    // rows this needs to become a SQL aggregate in both places at once.
    seeRevenue
      ? admin
          .from("payments")
          .select("amount_cents")
          .eq("status", "succeeded")
          .limit(10000)
      : { data: null },
    seeRevenue
      ? admin
          .from("user_charges")
          .select("amount_cents")
          .eq("status", "paid")
          .limit(10000)
      : { data: null },
    // The trend is read separately rather than bucketed out of the two sums
    // above, because those carry a 10k cap with no ordering: past that many
    // rows the lifetime total goes approximate, but an arbitrary 10k slice
    // would silently drop recent weeks and draw a revenue collapse that never
    // happened. A windowed query can't lose the window.
    //
    // Both series bucket by `created_at`, matching Pulse's revenue chart, so a
    // charge is counted in the week it was raised.
    seeRevenue
      ? admin
          .from("payments")
          .select("amount_cents, created_at")
          .eq("status", "succeeded")
          .gte("created_at", windowStart)
      : { data: null },
    seeRevenue
      ? admin
          .from("user_charges")
          .select("amount_cents, created_at")
          .eq("status", "paid")
          .gte("created_at", windowStart)
      : { data: null },
    seeApplications
      ? admin
          .from("applications")
          .select("id, full_name, status, submitted_at, created_at")
          .order("created_at", { ascending: false })
          .limit(6)
      : { data: null },
  ]);

  const revenueCents =
    (payments ?? []).reduce((s, p) => s + (p.amount_cents ?? 0), 0) +
    (charges ?? []).reduce((s, c) => s + (c.amount_cents ?? 0), 0);

  // One bucket per week, from the calendar rather than from the rows — a week
  // with no payments has no rows, and dropping it would compress the axis and
  // make a gap look like a shorter history.
  const inWeek = (iso: string, w: { start: Date; end: Date }) => {
    const t = new Date(iso);
    return t >= w.start && t < w.end;
  };
  const revenueByWeek = weeks.map((w) => ({
    key: w.key,
    label: w.label,
    value:
      (windowPayments ?? [])
        .filter((p) => inWeek(p.created_at as string, w))
        .reduce((s, p) => s + (p.amount_cents ?? 0), 0) +
      (windowCharges ?? [])
        .filter((c) => inWeek(c.created_at as string, w))
        .reduce((s, c) => s + (c.amount_cents ?? 0), 0),
  }));

  // Distinct people, not enrollment rows: two seats in two active cohorts is
  // one student, and the check-in ratio below divides by this.
  const enrolledUserIds = new Set(
    (enrollmentRows ?? []).map((e) => e.user_id as string),
  );
  const enrolled = seePeople ? enrolledUserIds.size : null;
  // Only check-ins from someone actually in the denominator, deduped. This is
  // what keeps the ratio inside 0–100% by construction, which is the property
  // the Ring and the warn threshold below both assume.
  const checkedIn = seePeople
    ? new Set(
        (checkinRows ?? [])
          .map((c) => c.user_id as string)
          .filter((id) => enrolledUserIds.has(id)),
      ).size
    : null;
  const capacity = seePeople
    ? (activeCohorts ?? []).reduce((s, c) => s + ((c.capacity as number) ?? 0), 0)
    : 0;

  const firstName = profile.full_name?.split(" ")[0] || "there";
  const showCheckin = seePeople && (enrolled ?? 0) > 0;
  // Mirrors Spark's own `hasLine` test exactly. Spark refuses to draw an
  // all-zero series — correctly, since a line pinned to the axis reads as a
  // broken chart — but the branch it falls back to renders only its summary
  // and drops the `caption`, and the caption is where the lifetime total now
  // lives. Between cohorts every one of the eight weeks is zero, so the tile
  // would have been a single grey sentence with the program's entire revenue
  // history nowhere on the screen. Fall back to the total then, the same way
  // the Enrolled tile falls back when it has no ceiling to measure against.
  const showRevenueTrend = revenueByWeek.some((w) => w.value !== 0);

  return (
    <>
      <AppHeader
        title={`Morning, ${firstName}`}
        eyebrow={`Admin · ${formatWeekRange(weekStart)}`}
      />
      <AppBody>
        {/* The queue. Two numbers that are someone waiting on you, not stats. */}
        {seeApplications && (
          <Section title="Waiting on you">
            <div className="grid grid-cols-2 gap-2.5">
              <Stat
                label="To review"
                value={pending ?? 0}
                href="/app/admin/review"
                tone={(pending ?? 0) > 0 ? "accent" : "default"}
                hint={(pending ?? 0) > 0 ? "Tap to decide" : "All caught up"}
              />
              <Stat
                label="Awaiting payment"
                value={awaitingPayment ?? 0}
                href="/app/admin/awaiting-payment"
                tone={(awaitingPayment ?? 0) > 0 ? "warn" : "default"}
                hint="Accepted, unpaid"
              />
            </div>
          </Section>
        )}

        {(seePeople || seeRevenue || seeAtRisk) && (
          <Section title="The program">
            {/* Every tile is a link. A number on a touch screen reads as
                tappable whether or not it is, so a tile that does nothing is
                indistinguishable from one that is broken — and each of these
                already implies exactly one destination. The href is always a
                page the tile's own permission can open, and always inside the
                app: every one of these used to land in /admin, which has no tab
                bar, a sidebar, and in the payments case a seven-column table
                whose Refund button is clipped off a phone screen. */}
            <div className="grid grid-cols-2 gap-2.5">
              {seePeople && (
                <Stat
                  label="Enrolled"
                  value={enrolled ?? 0}
                  href="/app/admin/people"
                  // A headcount only means something against the seats it is
                  // filling: 24 is a full cohort or a half-empty one and the
                  // number alone can't say which.
                  //
                  // With no active cohort there is no ceiling, and Meter
                  // correctly degrades to a single small sentence — but on a
                  // tile that leaves nothing to read at a glance, so the plain
                  // count stays the subject until there are seats to measure.
                  graphic={
                    capacity > 0 ? (
                      <Meter
                        label="Enrolled"
                        value={enrolled ?? 0}
                        max={capacity}
                        caption="Of active cohort seats"
                      />
                    ) : undefined
                  }
                  hint={capacity > 0 ? undefined : "In active cohorts"}
                />
              )}
              {showCheckin && (
                <Stat
                  label="Checked in"
                  // Never rendered — the Ring prints its own figure — but Stat
                  // requires a value, and this is the one it stands in for.
                  value={`${checkedIn}/${enrolled}`}
                  // The directory, for every viewer. This tile used to send
                  // anyone with `pulse.view` to /app/admin/pulse, which does
                  // not exist — the in-app screens for the other three tiles
                  // landed and that one did not, so the reader best placed to
                  // act on a low check-in rate was the only one who got a
                  // not-found. The directory is where you message a student
                  // who has gone quiet, so it is a real destination rather
                  // than a placeholder. Restore the branch (and `pulse.view`)
                  // the day an in-app Pulse ships.
                  href="/app/admin/people"
                  graphic={
                    <Ring
                      label="Checked in"
                      value={checkedIn ?? 0}
                      max={enrolled ?? 0}
                      caption={`${checkedIn} of ${enrolled} this week`}
                      // A binary threshold was the tile's only encoding of the
                      // rate, so 51% and 99% looked identical. Now the arc
                      // carries the value and the tone only flags the half of
                      // the roster that has gone quiet. Safe as a threshold
                      // because the numerator is a subset of the denominator
                      // (see the queries) — it cannot exceed 100%.
                      tone={
                        (checkedIn ?? 0) < (enrolled ?? 0) / 2
                          ? "warn"
                          : "default"
                      }
                    />
                  }
                />
              )}
              {seeAtRisk && (
                <Stat
                  label="At risk"
                  value={atRisk ?? 0}
                  href="/app/admin/at-risk"
                  tone={(atRisk ?? 0) > 0 ? "warn" : "default"}
                  hint="Open flags"
                />
              )}
              {seeRevenue && (
                <Stat
                  label="Revenue"
                  value={money(revenueCents)}
                  href="/app/admin/payments"
                  // Full width: a lifetime total is the one number where
                  // today's value carries no information — it only ever goes
                  // up, and reads the same whether last week brought $12,000 or
                  // nothing. The last eight weeks answer the question the tile
                  // was pretending to; the total stays as the caption, where a
                  // long currency string fits at 11.5px and, unlike at 34px in
                  // half a grid, cannot collide with the tile beside it.
                  //
                  // `span` stays on in both branches: full width is also what
                  // makes the fallback safe, since a lifetime total is the one
                  // string long enough to overflow a half-grid tile even at the
                  // clamped size.
                  span
                  graphic={
                    showRevenueTrend ? (
                      <Spark
                        label="Revenue"
                        points={revenueByWeek}
                        format={compactMoney}
                        caption={`${money(revenueCents)} all time · last ${TREND_WEEKS} weeks`}
                      />
                    ) : undefined
                  }
                  hint={
                    showRevenueTrend
                      ? undefined
                      : `All time · nothing in ${TREND_WEEKS} weeks`
                  }
                />
              )}
            </div>
          </Section>
        )}

        {seeApplications && (
          <Section
            title="Recent applications"
            action={{ href: "/app/admin/review", label: "Review" }}
          >
            {(recent ?? []).length === 0 ? (
              <Empty>No applications yet.</Empty>
            ) : (
              <div className="rounded-2xl border border-line px-4 sm:px-5">
                {/* Name, date and status on one line was a three-column table
                    row wearing a flex layout: the date and badge are shrink-0,
                    so at 320px they took 185px of a 246px row and the name —
                    the only reason anyone taps — got about five glyphs. The
                    date drops to `meta`, where Row already gives it a line of
                    its own, and the status shrinks to three glyphs. */}
                {(recent ?? []).map((a) => {
                  const status = a.status as string;
                  // Only the rows the review queue actually contains are
                  // links. This list is the six most recent applications by
                  // `created_at` at any status, but /app/admin/review filters
                  // to submitted+waitlisted — so linking all of them meant
                  // tapping a rejected or enrolled applicant landed you in a
                  // list that provably does not include them, with nothing on
                  // screen to say why. There is no in-app detail route to send
                  // the others to, and the desktop one is outside the shell,
                  // so a settled application is history: rendered muted and
                  // not tappable, which is the honest shape of "nowhere to go
                  // from here" rather than a tap that silently misses.
                  const actionable =
                    status === "submitted" || status === "waitlisted";
                  return (
                    <Row
                      key={a.id as string}
                      label={(a.full_name as string) || "Unnamed applicant"}
                      // The queue, not /admin/applications/[id]: there is no
                      // in-app detail screen, and the desktop one is outside
                      // the shell. prefetch={false} because these rows all
                      // resolve to the one route the section header and the
                      // "To review" tile already prefetch.
                      href={actionable ? "/app/admin/review" : undefined}
                      prefetch={false}
                      muted={!actionable}
                      meta={
                        <LocalTime
                          value={
                            (a.submitted_at as string) ||
                            (a.created_at as string)
                          }
                          mode="date"
                        />
                      }
                      right={
                        <span className="shrink-0 font-mono text-[11px] font-medium uppercase tracking-wider text-ink-soft">
                          <span aria-hidden>
                            {STATUS_ABBR[status] ?? status.slice(0, 3)}
                          </span>
                          <span className="sr-only">{status}</span>
                        </span>
                      }
                    />
                  );
                })}
              </div>
            )}
          </Section>
        )}

        <div className="mt-8">
          <InstallHint />
        </div>
      </AppBody>
    </>
  );
}
