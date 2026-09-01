import { requireViewer } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { isoWeekStart, formatWeekRange } from "@/lib/week";
import { InstallHint } from "@/components/app/install-hint";
import {
  AppHeader,
  AppBody,
  Section,
  Stat,
  Row,
  Empty,
} from "@/components/app/frame";

export const metadata = { title: "Admin · batch0" };
export const dynamic = "force-dynamic";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

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
  // Only decides where the "Checked in" tile points — it gates no data here.
  const seePulse = can(caps, "pulse.view");

  const admin = createAdminClient();
  const weekStart = isoWeekStart();

  const [
    { count: pending },
    { count: awaitingPayment },
    { count: enrolled },
    { count: checkedIn },
    { count: atRisk },
    { data: payments },
    { data: charges },
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
          .from("enrollments")
          .select("id, cohort:cohorts!inner(status)", { count: "exact", head: true })
          .eq("cohort.status", "active")
      : { count: null },
    seePeople
      ? admin
          .from("student_checkins")
          .select("id", { count: "exact", head: true })
          .eq("week_start", weekStart)
      : { count: null },
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

  const firstName = profile.full_name?.split(" ")[0] || "there";
  const checkinRate =
    seePeople && (enrolled ?? 0) > 0
      ? `${checkedIn ?? 0}/${enrolled}`
      : null;

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
                href="/admin/applications?status=accepted"
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
                page the tile's own permission can open: `Enrolled` needs
                people.view and goes to the in-app directory; `Checked in`
                prefers Pulse (the check-in analytics) but falls back to the
                directory for a role without pulse.view; `Revenue` needs
                payments.view and goes to the payments ledger it is summing. */}
            <div className="grid grid-cols-2 gap-2.5">
              {seePeople && (
                <Stat
                  label="Enrolled"
                  value={enrolled ?? 0}
                  href="/app/admin/people"
                  // Says what the number now actually counts. It is scoped to
                  // running cohorts (see the query), and a tile labelled just
                  // "Enrolled" next to a smaller figure than last week would
                  // read as churn rather than as a narrower question.
                  hint="In active cohorts"
                />
              )}
              {checkinRate && (
                <Stat
                  label="Checked in"
                  value={checkinRate}
                  hint="This week"
                  href={seePulse ? "/admin/pulse" : "/app/admin/people"}
                  tone={
                    (checkedIn ?? 0) < (enrolled ?? 0) / 2 ? "warn" : "default"
                  }
                />
              )}
              {seeAtRisk && (
                <Stat
                  label="At risk"
                  value={atRisk ?? 0}
                  href="/admin/interventions"
                  tone={(atRisk ?? 0) > 0 ? "warn" : "default"}
                  hint="Open flags"
                />
              )}
              {seeRevenue && (
                <Stat
                  label="Revenue"
                  value={money(revenueCents)}
                  href="/admin/payments"
                  hint="Every payment"
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
                {(recent ?? []).map((a) => (
                  <Row
                    key={a.id as string}
                    label={(a.full_name as string) || "Unnamed applicant"}
                    href={`/admin/applications/${a.id}`}
                    right={
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                          <LocalTime
                            value={(a.submitted_at as string) || (a.created_at as string)}
                            mode="date"
                          />
                        </span>
                        <StatusBadge status={a.status as string} />
                      </div>
                    }
                  />
                ))}
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
