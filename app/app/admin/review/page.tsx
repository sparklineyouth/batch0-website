import { Fragment } from "react";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { passHolderUserIds } from "@/lib/founder-pass";
import { AppHeader, AppBody, Empty, Alert } from "@/components/app/frame";
import { ReviewCard, type ReviewItem } from "./review-card";

export const metadata = { title: "Review · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

const PAGE_SIZE = 25;

/**
 * The decision queue.
 *
 * Submitted first, then waitlisted — that's the real order of urgency. A
 * submitted application is someone refreshing their inbox; a waitlisted one is
 * someone already told "not yet", who becomes decidable again the moment a seat
 * opens. Everything already decided is absent: this screen is a queue, and a
 * queue that shows finished work is a list.
 *
 * Capped at 25 with a link to the full panel rather than paginated. Paging on a
 * phone through applications you are deciding one at a time is the wrong
 * interaction — if the queue is deeper than 25, the honest answer is that this
 * is a laptop session, and the link says so.
 */
export default async function AdminAppReview() {
  const { caps } = await requirePermission("applications.view");
  const canDecide = can(caps, "applications.review");
  const admin = createAdminClient();

  // Two reads in parallel. The second is head-only — it returns a count and no
  // rows — and it exists because the header's split used to be computed from
  // the capped `items` array. On a queue of 40 that made the header say
  // "25 awaiting" beside a tab badge reading 40, which is precisely the
  // disagreement the split was added to prevent.
  const [
    { data: apps, count, error },
    { count: submittedCount },
  ] = await Promise.all([
    admin
      .from("applications")
      .select(
        "id, user_id, full_name, age, grade, school, city, country, hours_per_week, why_join, startup_idea, experience, ai_score, ai_summary, status, submitted_at, profile:profiles!applications_user_id_fkey(email)",
        { count: "exact" },
      )
      .in("status", ["submitted", "waitlisted"])
      // "submitted" sorts before "waitlisted" alphabetically, which is also the
      // order of urgency — a happy accident worth a comment so nobody "fixes"
      // it. It also makes the two statuses contiguous, which is what lets the
      // list below label them with one divider instead of a chip per card.
      .order("status", { ascending: true })
      .order("submitted_at", { ascending: true, nullsFirst: false })
      .limit(PAGE_SIZE),
    admin
      .from("applications")
      .select("id", { count: "exact", head: true })
      .eq("status", "submitted"),
  ]);

  // One lookup for the whole page, not one per row. A pass changes what a
  // decline is allowed to be, so the card has to know before it renders.
  const passHolders = await passHolderUserIds(
    admin,
    (apps ?? []).map((a) => a.user_id as string).filter(Boolean),
  );

  const items: ReviewItem[] = (apps ?? []).map((a) => {
    const profile = (
      Array.isArray(a.profile) ? a.profile[0] : a.profile
    ) as { email?: string } | null;
    return {
      id: a.id as string,
      fullName: (a.full_name as string) || "Unnamed applicant",
      email: profile?.email ?? null,
      status: a.status as string,
      age: (a.age as number) ?? null,
      grade: (a.grade as string) ?? null,
      school: (a.school as string) ?? null,
      location: [a.city, a.country].filter(Boolean).join(", ") || null,
      hoursPerWeek: (a.hours_per_week as number) ?? null,
      whyJoin: (a.why_join as string) ?? null,
      startupIdea: (a.startup_idea as string) ?? null,
      experience: (a.experience as string) ?? null,
      aiScore: (a.ai_score as number) ?? null,
      aiSummary: (a.ai_summary as string) ?? null,
      submittedAt: (a.submitted_at as string) ?? null,
      holdsPass: passHolders.has(a.user_id as string),
    };
  });

  const total = count ?? items.length;
  // Split because the tab badge counts `submitted` only, and a header that
  // said "5 awaiting a decision" beside a badge reading 3 makes the admin
  // distrust both numbers. Waitlisted rows are re-decidable, not waiting.
  // Both sides are whole-table counts, so the header stays true past PAGE_SIZE.
  const waitlisted = submittedCount == null ? 0 : Math.max(0, total - submittedCount);
  // The list is sorted submitted-then-waitlisted, so the two groups are
  // contiguous and one divider is enough to say which is which. -1 when there
  // are no waitlisted rows on this page, which never matches an index.
  const firstWaitlisted = items.findIndex((i) => i.status === "waitlisted");

  return (
    <>
      <AppHeader
        title="Review"
        eyebrow={
          // An error is not an empty queue. Saying "Queue clear" when the
          // query failed tells the admin their work is done while the badge
          // insists otherwise — the one state where being quiet is dangerous.
          error
            ? "Couldn't load the queue"
            : total === 0
              ? "Queue clear"
              : // No split rather than a guessed one if either count read
                // failed. `count` matters as much as `submittedCount` here:
                // without it `total` falls back to the capped `items.length`,
                // and a header reading "40 awaiting" over 25 rows with no
                // "more are waiting" line is the same lie in the other
                // direction.
                submittedCount == null || count == null
                ? `${total} in the queue`
                : waitlisted > 0
                  ? `${submittedCount} awaiting · ${waitlisted} waitlisted`
                  : `${submittedCount} awaiting a decision`
        }
      />
      <AppBody>
        {!canDecide && (
          <div className="mb-4">
            <Alert tone="info" title="Read-only">
              You can read every application here — answers, summary and score.
              Deciding needs the “Decide applications” permission.
            </Alert>
          </div>
        )}

        {error ? (
          <Alert tone="warn" title="The applications query failed.">
            This is not an empty queue — nothing was read. Reload, and if it
            keeps failing open the full panel at /admin/applications.
          </Alert>
        ) : items.length === 0 ? (
          <Empty>Nothing waiting. Every application has a decision.</Empty>
        ) : (
          <div className="space-y-2.5">
            {items.map((item, i) => (
              <Fragment key={item.id}>
                {i === firstWaitlisted && (
                  // Sticky at the header's own height so the label survives a
                  // scroll into the middle of the group; z-20 keeps it under
                  // the header (z-30), so if that height ever drifts this
                  // slides beneath the title rather than over it. -mx-5 lets
                  // the background bleed to the screen edge, so cards pass
                  // behind it instead of beside it.
                  <div className="sticky top-[calc(max(1rem,env(safe-area-inset-top))+4rem)] z-20 -mx-5 bg-paper px-5 pb-1.5 pt-2.5">
                    <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
                      Waitlisted · re-decidable
                    </p>
                  </div>
                )}
                {/* One card for both roles. A role that can view but not decide
                    used to get a link into the desktop panel per row, so the
                    entire screen was an exit; the answers, summary and score
                    are already on this row and cost no extra query to show. */}
                <ReviewCard item={item} canDecide={canDecide} />
              </Fragment>
            ))}
          </div>
        )}

        {total > PAGE_SIZE && (
          <div className="mt-5 text-center">
            {/* Says what the query does. The order is status first, age second,
                so these are the oldest *submitted* applications — a waitlisted
                one from months ago never reaches this page while 25 newer
                submissions exist. "The 25 oldest" was a comfortable sentence
                about a queue nobody was actually being shown. */}
            <p className="text-[12px] leading-relaxed text-ink-faint">
              Showing {PAGE_SIZE}, oldest submitted first — waitlisted rows only
              appear once the submitted ones run out. {total - PAGE_SIZE} more
              are waiting, and a queue this deep is worth doing at a desk.
            </p>
            {/* A block target, not an anchor inside the sentence: inline, its
                hit area was the 19px line box, and `a.press { min-height }` is
                a no-op on a non-replaced inline element. */}
            <Link
              href="/admin/applications?status=submitted"
              prefetch={false}
              className="press mt-3 inline-flex h-11 items-center justify-center rounded-xl border border-line px-4 text-[13px] text-phosphor-ink"
            >
              Open the full panel
            </Link>
          </div>
        )}
      </AppBody>
    </>
  );
}
