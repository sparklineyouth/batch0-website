import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { passGrantsByUserId } from "@/lib/founder-pass";
import {
  formatCents,
  grantDiscountCents,
  type PassGrant,
} from "@/lib/founder-pass-tiers";
import { AppHeader, AppBody, Section, Row, Empty } from "@/components/app/frame";
import { StageBars } from "@/components/app/viz";

export const metadata = { title: "Awaiting payment · Admin" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
/** The same tuition fallback checkout uses when an application has no cohort
 *  row, so this screen and Stripe can't quote two different list prices. */
const DEFAULT_PRICE_CENTS = 13000;
const DAY_MS = 86_400_000;

function embed<T>(value: unknown): T | null {
  if (!value) return null;
  return (Array.isArray(value) ? value[0] : value) as T;
}

/**
 * Accepted, not yet paid.
 *
 * The desktop destination for this list is the applications table: a nine-track
 * grid whose own comment admits its widths are budgeted against the header
 * labels. At 390px each flexible track is about 24px, four cells truncate to
 * nothing, and the card around it is `overflow-hidden`, so there is not even a
 * sideways scroll to recover what was clipped.
 *
 * What an admin needs from a phone is much narrower and fits: who is sitting on
 * an offer, how long they have been sitting on it, and what they owe. Longest
 * wait first — that is the order you would chase them in.
 *
 * The funnel above the list is cumulative by lifecycle (`accepted -> paid ->
 * enrolled`), not four current-status counts, because StageBars requires each
 * stage to be a subset of the one above it. "Paid" therefore includes everyone
 * enrolled, and the conversion between the bars is the number this screen is
 * really about: of everyone we said yes to, how many ever paid.
 */
export default async function AdminAppAwaitingPayment() {
  const { caps } = await requirePermission("applications.view");
  const admin = createAdminClient();

  const [waitingRes, funnelRes] = await Promise.all([
    admin
      .from("applications")
      .select(
        "id, user_id, full_name, reviewed_at, created_at, cohort:cohorts(name, price_cents), profile:profiles!applications_user_id_fkey(email)",
        { count: "exact" },
      )
      .eq("status", "accepted")
      // Oldest acceptance first. `nullsFirst: false` keeps an application with
      // no recorded decision time — a hand-edited row, or one accepted before
      // reviewed_at was written — at the bottom rather than at the top of a
      // list sorted by urgency.
      .order("reviewed_at", { ascending: true, nullsFirst: false })
      .limit(PAGE_SIZE),
    // One skinny scan for the funnel. Same explicit cap as every other
    // count-by-summing in this codebase.
    admin.from("applications").select("status").limit(10000),
  ]);

  const waiting = (waitingRes.data ?? []) as {
    id: string;
    user_id: string;
    full_name: string | null;
    reviewed_at: string | null;
    cohort: unknown;
    profile: unknown;
  }[];

  // Second wave: keyed on the user ids the query above returns, so it cannot
  // start earlier. One lookup for the page, not one per row — and skipped
  // entirely on an empty queue, since passGrantsByUserId with no ids would
  // still make the round trip.
  const passUserIds = waiting.map((a) => a.user_id).filter(Boolean);
  const grants = passUserIds.length
    ? await passGrantsByUserId(admin, passUserIds)
    : new Map<string, PassGrant>();

  const statuses = ((funnelRes.data ?? []) as { status: string }[]).map(
    (a) => a.status,
  );
  const count = (of: string[]) =>
    statuses.filter((s) => of.includes(s)).length;
  // `withdrawn` is deliberately in none of these. Someone who pulled out has
  // left the funnel rather than stalled inside it, and counting them as an
  // acceptance that never paid would make the conversion permanently worse.
  const everAccepted = count(["accepted", "paid", "enrolled"]);
  const everPaid = count(["paid", "enrolled"]);
  const enrolled = count(["enrolled"]);

  const rows = waiting.map((a) => {
    const cohort = embed<{ name: string | null; price_cents: number | null }>(
      a.cohort,
    );
    const profile = embed<{ email: string | null }>(a.profile);
    const listCents = cohort?.price_cents ?? DEFAULT_PRICE_CENTS;
    const grant = grants.get(a.user_id);
    // A full-ride pass holder owes nothing, and chasing them for $130 is the
    // one message this screen must never prompt.
    const owedCents = Math.max(
      0,
      listCents - (grant ? grantDiscountCents(grant, listCents) : 0),
    );
    const days = a.reviewed_at
      ? // A day count, not an instant, so it is safe to compute on the server —
        // LocalTime exists because a *timestamp* formatted in UTC is wrong for
        // the reader, but "11 days" is the same number in every timezone.
        Math.max(
          0,
          Math.floor((Date.now() - new Date(a.reviewed_at).getTime()) / DAY_MS),
        )
      : null;
    return {
      id: a.id,
      userId: a.user_id,
      name: a.full_name || profile?.email || "Unnamed applicant",
      cohortName: cohort?.name ?? null,
      owedCents,
      days,
    };
  });

  const total = waitingRes.count ?? rows.length;
  const outstandingCents = rows.reduce((s, r) => s + r.owedCents, 0);
  const seePeople = can(caps, "people.view");

  return (
    <>
      <AppHeader
        title="Awaiting payment"
        eyebrow={
          waitingRes.error
            ? "Couldn't load the list"
            : total === 0
              ? "Nobody waiting"
              : // The money only rides along when it covers everyone counted.
                // `outstandingCents` sums the rows on this page and `total` is
                // the exact count of every accepted-unpaid application, so past
                // PAGE_SIZE the pair reads as "47 accepted owe $3,250" when the
                // real figure is nearly double — an understated debt is worse
                // than no figure at all.
                `${total} accepted${
                  total === rows.length
                    ? ` · ${formatCents(outstandingCents)} outstanding`
                    : ""
                }`
        }
      />
      <AppBody>
        {/* Hidden rather than drawn at zero when the scan fails. StageBars
            floors its top stage at 1, so three empty tracks labelled 0 render
            as a confident "we have never accepted anyone" — a failed read
            dressed as a finding. The list below is a separate query and is
            still worth showing. */}
        {!funnelRes.error && (
          <Section title="Acceptance to enrolment">
            <StageBars
              label="Application funnel"
              stages={[
                { key: "accepted", label: "Accepted", value: everAccepted },
                { key: "paid", label: "Paid", value: everPaid },
                { key: "enrolled", label: "Enrolled", value: enrolled },
              ]}
              caption="Every acceptance ever made, and how far each got."
            />
          </Section>
        )}

        <Section title="Longest wait first">
          {rows.length === 0 ? (
            // Zero rows from a failed read and zero rows from a cleared queue
            // are the same shape and opposite facts; "everyone has paid" is the
            // expensive one to guess wrong.
            <Empty>
              {waitingRes.error
                ? "The list didn't load, so this is empty for the wrong reason. Reload, or open the full list at /admin/applications."
                : "Everyone we accepted has paid."}
            </Empty>
          ) : (
            <div className="rounded-2xl border border-line px-4 sm:px-5">
              {rows.map((r) => (
                <Row
                  key={r.id}
                  label={r.name}
                  value={r.cohortName ?? undefined}
                  meta={
                    r.days == null ? (
                      "No decision date recorded"
                    ) : (
                      <span
                        // A week is the point where an offer stops being fresh
                        // and starts being a lapse worth a message.
                        className={
                          r.days >= 7 ? "text-amber-600 dark:text-amber-300" : ""
                        }
                      >
                        Accepted{" "}
                        {r.days === 0
                          ? "today"
                          : `${r.days} day${r.days === 1 ? "" : "s"} ago`}
                      </span>
                    )
                  }
                  right={
                    <span className="shrink-0 font-mono text-[13px] tabular-nums text-ink-soft">
                      {formatCents(r.owedCents)}
                    </span>
                  }
                  // The useful destination is the person — their email is what
                  // you came for. A role that can read applications but not
                  // people falls back to the desktop application record, the
                  // same fallback the in-app Review screen uses for a reader
                  // who cannot decide.
                  href={
                    seePeople
                      ? `/app/admin/people/${r.userId}`
                      : `/admin/applications/${r.id}`
                  }
                  // False for both destinations. The in-app one is
                  // force-dynamic behind this segment's shared loading.tsx, so
                  // every prefetch returns the same static shell — the call
                  // /app/admin/people already makes for the same route — and
                  // the desktop one has no boundary at all.
                  prefetch={false}
                />
              ))}
            </div>
          )}
        </Section>

        {rows.length > 0 && (
          <p className="mt-5 text-[12px] leading-relaxed text-ink-faint">
            Amounts are the cohort list price less any founder-pass discount.
            Checkout also applies a regional adjustment keyed on the applicant's
            own country, which this render cannot see — so a student outside the
            US may owe less than the figure here.
          </p>
        )}

        {total > rows.length && (
          <p className="mt-3 text-center text-[12px] leading-relaxed text-ink-faint">
            {/* The outstanding total moves here rather than disappearing when
                the page is capped: beside "the {rows.length} longest-waiting"
                it is scoped to exactly the rows it was summed from, which is
                the sentence the eyebrow had no room to say. */}
            Showing the {rows.length} longest-waiting, owing{" "}
            {formatCents(outstandingCents)} between them. {total - rows.length}{" "}
            more are accepted and unpaid —{" "}
            <Link
              href="/admin/applications?status=accepted"
              prefetch={false}
              className="text-phosphor-ink underline"
            >
              the full list
            </Link>{" "}
            has all of them.
          </p>
        )}
      </AppBody>
    </>
  );
}
