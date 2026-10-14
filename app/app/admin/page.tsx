import { requireViewer } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { isoWeekStart, formatWeekRange } from "@/lib/week";
import { InstallHint } from "@/components/app/install-hint";
import { countOverdueAssignments } from "@/lib/assignments-server";
import { netRevenueCents } from "@/lib/revenue-ledger";
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
 * Overdue assignments is the one number that changes the day: who is quietly
 * falling behind, while there's still time to send a message about it.
 */
export default async function AdminAppToday() {
  const { profile, caps } = await requireViewer();
  const seeApplications = can(caps, "applications.view");
  const seePeople = can(caps, "people.view");
  const seeRevenue = can(caps, "payments.view");
  const seeAssignments = can(caps, "assignments.manage");

  const admin = createAdminClient();
  const weekStart = isoWeekStart();

  const [
    { count: pending },
    { count: awaitingPayment },
    { count: enrolled },
    overdue,
    revenueCents,
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
          // cohort. Scoped to cohorts actually running, it means what it says.
          .from("enrollments")
          .select("id, cohort:cohorts!inner(status)", { count: "exact", head: true })
          .eq("cohort.status", "active")
      : { count: null },
    seeAssignments ? countOverdueAssignments(admin) : Promise.resolve(0),
    // The same number as the desktop overview (net of refunds).
    seeRevenue ? netRevenueCents(admin) : Promise.resolve(null),
    seeApplications
      ? admin
          .from("applications")
          .select("id, full_name, status, submitted_at, created_at")
          .order("created_at", { ascending: false })
          .limit(6)
      : { data: null },
  ]);

  const firstName = profile.full_name?.split(" ")[0] || "there";

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

        {(seePeople || seeRevenue || seeAssignments) && (
          <Section title="The program">
            {/* Every tile is a link. A number on a touch screen reads as
                tappable whether or not it is, so a tile that does nothing is
                indistinguishable from one that is broken — and each of these
                already implies exactly one destination. The href is always a
                page the tile's own permission can open: `Enrolled` needs
                people.view and goes to the in-app directory; `Overdue` needs
                assignments.manage and goes to the completion matrix;
                `Revenue` needs payments.view and goes to the payments ledger
                it is summing. */}
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
              {seeAssignments && (
                <Stat
                  label="Overdue"
                  value={overdue}
                  href="/admin/assignments"
                  tone={overdue > 0 ? "warn" : "default"}
                  hint="Assignments not in"
                />
              )}
              {seeRevenue && (
                <Stat
                  label="Revenue"
                  value={revenueCents === null ? "Unavailable" : money(revenueCents)}
                  href="/admin/payments"
                  hint="After refunds"
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
