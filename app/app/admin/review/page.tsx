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

  const { data: apps, count } = await admin
    .from("applications")
    .select(
      "id, user_id, full_name, age, grade, school, city, country, hours_per_week, why_join, startup_idea, experience, ai_score, ai_summary, status, submitted_at, profile:profiles!applications_user_id_fkey(email)",
      { count: "exact" },
    )
    .in("status", ["submitted", "waitlisted"])
    // "submitted" sorts before "waitlisted" alphabetically, which is also the
    // order of urgency — a happy accident worth a comment so nobody "fixes" it.
    .order("status", { ascending: true })
    .order("submitted_at", { ascending: true, nullsFirst: false })
    .limit(PAGE_SIZE);

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

  return (
    <>
      <AppHeader
        title="Review"
        eyebrow={
          total === 0
            ? "Queue clear"
            : `${total} awaiting a decision`
        }
      />
      <AppBody>
        {!canDecide && (
          <div className="mb-4">
            <Alert tone="info" title="Read-only">
              Your role can open applications but not decide them. Deciding needs
              the “Decide applications” permission.
            </Alert>
          </div>
        )}

        {items.length === 0 ? (
          <Empty>Nothing waiting. Every application has a decision.</Empty>
        ) : (
          <div className="space-y-2.5">
            {items.map((item) =>
              canDecide ? (
                <ReviewCard key={item.id} item={item} />
              ) : (
                <Link
                  key={item.id}
                  href={`/admin/applications/${item.id}`}
                  prefetch={false}
                  className="press block rounded-2xl border border-line bg-wash px-5 py-4 active:scale-[0.99]"
                >
                  <p className="text-[15px] leading-tight text-ink">
                    {item.fullName}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-ink-faint">
                    {item.status}
                    {item.location ? ` · ${item.location}` : ""}
                  </p>
                </Link>
              ),
            )}
          </div>
        )}

        {total > PAGE_SIZE && (
          <p className="mt-5 text-center text-[12px] leading-relaxed text-ink-faint">
            Showing the {PAGE_SIZE} oldest. {total - PAGE_SIZE} more are waiting —
            a queue this deep is worth doing in{" "}
            <Link
              href="/admin/applications?status=submitted"
              prefetch={false}
              className="text-phosphor-ink underline"
            >
              the full panel
            </Link>
            , where you can bulk-decide.
          </p>
        )}
      </AppBody>
    </>
  );
}
