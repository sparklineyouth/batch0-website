import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { LocalTime } from "@/components/ui/local-time";
import { AppHeader, AppBody, Empty } from "@/components/app/frame";
import type { Role } from "@/lib/types";

export const metadata = { title: "Announcements · batch0" };
export const dynamic = "force-dynamic";

/**
 * Announcements, read-only.
 *
 * The desktop page also carries emoji reactions (migration 0027). They're
 * omitted here on purpose: reacting is a social nicety, reading is the job, and
 * every reaction control is another 44px target competing with the text on a
 * 390px screen. Reactions still work from /dashboard/announcements.
 *
 * Capped at 30. Announcements accumulate for the life of a cohort and nobody
 * scrolls to the fortieth; an uncapped list is a payload that grows forever on
 * the connection least able to carry it.
 */
export default async function StudentAppAnnouncements() {
  const { profile } = await requireViewer();
  const access = await getStudentAccess(profile.role as Role);
  const admin = createAdminClient();

  // Mirrors the RLS policy on `announcements`: cohort-scoped posts plus the
  // global ones. A student with no cohort sees only the global posts rather
  // than an error.
  let query = admin
    .from("announcements")
    .select("id, title, body, created_at")
    .order("created_at", { ascending: false })
    .limit(30);
  query = access.cohortId
    ? query.or(`cohort_id.is.null,cohort_id.eq.${access.cohortId}`)
    : query.is("cohort_id", null);
  const { data: announcements } = await query;

  return (
    <>
      <AppHeader title="Announcements" eyebrow="From the batch0 team" />
      <AppBody>
        {(announcements ?? []).length === 0 ? (
          <Empty>Nothing announced yet.</Empty>
        ) : (
          <div className="space-y-3">
            {(announcements ?? []).map((a) => (
              <article
                key={a.id as string}
                className="rounded-2xl border border-line bg-wash px-5 py-4"
              >
                <h2 className="text-[15px] font-medium leading-snug text-ink">
                  {a.title as string}
                </h2>
                <p className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-soft">
                  {a.body as string}
                </p>
                <p className="mt-3 font-mono text-[11px] tabular-nums text-ink-faint">
                  <LocalTime value={a.created_at as string} mode="datetime-short" />
                </p>
              </article>
            ))}
          </div>
        )}
      </AppBody>
    </>
  );
}
