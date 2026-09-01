import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { getCohortAnnouncements } from "@/lib/app-cache";
import { LocalTime } from "@/components/ui/local-time";
import { AppHeader, AppBody, Empty, Alert } from "@/components/app/frame";
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

  // ENROLLMENT GATE — must stay above any query. Same reasoning as
  // app/app/(student)/events/page.tsx: the reads below run through
  // createAdminClient() with the service role, so the `announcements` RLS
  // policy from migration 0027 (which requires a row in `enrollments` for BOTH
  // the cohort-scoped and the global branch) never applies. This check is the
  // enforcement, not a convenience.
  //
  // lib/nav-config.ts already lists /dashboard/announcements in
  // ENROLLED_ONLY_HREFS for exactly this reason, and
  // /dashboard/announcements renders <LockedFeature> here.
  if (!access.enrolled) {
    return (
      <>
        <AppHeader title="Announcements" eyebrow="Locked" />
        <AppBody>
          <Alert tone="info" title="Announcements open at enrollment.">
            This is how the team reaches your cohort — it unlocks once your seat
            is paid for.
          </Alert>
        </AppBody>
      </>
    );
  }
  // Mirrors the RLS policy on `announcements`: cohort-scoped posts plus the
  // global ones. A student with no cohort sees only the global posts rather
  // than an error. Cached per cohort (lib/app-cache.ts) — staff-authored
  // content that a whole cohort reads, so it is shared rather than re-queried
  // for each of them.
  //
  // Capped at 30. Announcements accumulate for the life of a cohort and nobody
  // scrolls to the fortieth; an uncapped list is a payload that grows forever
  // on the connection least able to carry it.
  const announcements = await getCohortAnnouncements(
    { cohortId: access.cohortId },
    30,
  );

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
                <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-soft [overflow-wrap:anywhere]">
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
