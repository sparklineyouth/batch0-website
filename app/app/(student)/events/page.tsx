import Link from "next/link";
import { Video, MapPin } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { enrolledCohortIds, getStudentAccess } from "@/lib/access";
import { AppLockedAlert } from "@/components/app/locked-alert";
import {
  getCohortEvents,
  getCohortRecordings,
  getPreviewEvents,
  getPreviewRecordings,
} from "@/lib/app-cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordedEventIds } from "@/lib/event-recordings";
import { LocalTime } from "@/components/ui/local-time";
import { httpsUrl, studentEventStatus } from "@/lib/event-form";
import { isHostedOnBatch0 } from "@/lib/webinars";
import {
  historyHref,
  needsRecordingLookup,
  parseHistoryPage,
  recordingLink,
} from "@/lib/event-history";
import {
  AppHeader,
  AppBody,
  Section,
  Empty,
  Row,
} from "@/components/app/frame";
import type { Role } from "@/lib/types";

export const metadata = { title: "Events · batch0" };
export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  demo_day: "Demo Day",
  office_hours: "Office hours",
  workshop: "Workshop",
  webinar: "Webinar",
  other: "Event",
};

/**
 * The calendar, upcoming-first, with a one-tap Join: the batch0 room for a
 * hosted event once it opens (15 minutes before, or when a host goes live),
 * the pasted link for an external one. Past events keep their recording: a
 * pasted link, or a hosted webinar's own once it is shared (its room page).
 *
 * Recordings page (`?page=`), and the filter is in the query: this used to
 * read the five newest past events and keep the recorded ones, so five
 * recent sessions without a recording hid every older one.
 */
export default async function StudentAppEvents(props: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { profile } = await requireViewer();
  const access = await getStudentAccess(profile.role as Role);

  // ENROLLMENT GATE — must stay above any query.
  //
  // The app shell admits anyone with a live application (lib/app-eligibility.ts),
  // which is deliberate: a waitlisted applicant should be able to open the app.
  // But events are enrolled-only content, and every read here goes through
  // createAdminClient(), which uses the service role and therefore BYPASSES the
  // `events read` RLS policy that would otherwise have enforced this. RLS is not
  // a backstop on this code path; this check is the only thing standing between
  // an unpaid applicant and a cohort's live Zoom join links.
  //
  // /dashboard/events draws the same line with <LockedFeature>. A phone surface
  // must never be more permissive than the page it mirrors.
  //
  // Staff resolve as enrolled (lib/access.ts), so previewing still works.
  if (!access.enrolled) {
    return (
      <>
        <AppHeader title="Events" eyebrow="Locked" />
        <AppBody>
          <AppLockedAlert
            title="Events unlock at enrollment."
            applicationStatus={access.applicationStatus}
          />
        </AppBody>
      </>
    );
  }

  const nowIso = new Date().toISOString();
  const page = parseHistoryPage((await props.searchParams).page);

  // Cached (lib/app-cache.ts): the calendar is staff-authored and changes a few
  // times a cohort, so it is shared across everyone in that cohort for a minute
  // — and the prefetcher has usually warmed it before this screen is opened.
  // Later pages of recordings skip the calendar: they are only that list.
  //
  // Scoped to every cohort the student is enrolled in, as the `events read`
  // policy is, and not to access.cohortId: that is one cohort, possibly one
  // they are only accepted into, so a returning student (or one accepted into
  // the next cohort) saw another cohort's recordings and lost their own.
  //
  // Staff previewing hold no enrollments, so that scope showed them public
  // events only. They read through their own session instead (uncached), so
  // the policy itself decides — what /dashboard/events shows them
  // (getPreviewEvents in lib/app-cache.ts). Students never take that path.
  const scope = access.staff ? null : { cohortIds: await enrolledCohortIds() };
  const [{ upcoming }, recordingPage] = await Promise.all([
    page === 1
      ? scope
        ? getCohortEvents(scope, nowIso)
        : getPreviewEvents(nowIso)
      : Promise.resolve({ upcoming: [] }),
    scope ? getCohortRecordings(scope, nowIso, page) : getPreviewRecordings(nowIso, page),
  ]);
  const now = new Date(nowIso);
  const statusOf = (e: (typeof upcoming)[number]) =>
    studentEventStatus(
      {
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        liveStartedAt: e.live_started_at,
        liveEndedAt: e.live_ended_at,
      },
      now,
    );
  const ahead = upcoming
    // The external link through httpsUrl, as the home reads it: the column
    // holds whatever was ever written to it (lib/event-form.ts).
    .map((e) => ({ e, s: statusOf(e), joinUrl: httpsUrl(e.zoom_url) }))
    .filter((x) => x.s === "live" || x.s === "open" || x.s === "upcoming")
    .sort((a, b) => Number(b.s === "live") - Number(a.s === "live"));

  // A recording to watch: a pasted link, or a hosted webinar's own once it is
  // shared (played on its room page). A shared one with no take yet matched
  // the query and is dropped here.
  const recorded = await recordedEventIds(
    createAdminClient(),
    recordingPage.rows.filter(needsRecordingLookup).map((e) => e.id),
  );
  const recordings = recordingPage.rows.flatMap((e) => {
    const link = recordingLink(e, recorded);
    return link ? [{ e, ...link }] : [];
  });
  const paged = page > 1 || recordingPage.hasMore;

  return (
    <>
      <AppHeader
        title={page > 1 ? "Recordings" : "Events"}
        eyebrow={page > 1 ? `Page ${page}` : "Live sessions, Demo Day"}
      />
      <AppBody>
        {page === 1 && (
          <Section title="Upcoming">
            {ahead.length === 0 ? (
              <Empty>Nothing scheduled right now.</Empty>
            ) : (
              <div className="space-y-2.5">
                {ahead.map(({ e, s, joinUrl }) => (
                  <div
                    key={e.id as string}
                    className="rounded-2xl border border-line bg-wash px-5 py-4"
                  >
                    <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-phosphor-ink">
                      {s === "live" ? "Live now · " : ""}
                      {TYPE_LABEL[e.type as string] ?? "Event"}
                    </p>
                    <p className="mt-1.5 text-[15px] leading-snug text-ink">
                      {e.title as string}
                    </p>
                    <p className="mt-1.5 font-mono text-[12px] tabular-nums text-ink-soft">
                      <LocalTime value={e.starts_at as string} mode="datetime" />
                    </p>
                    {!!e.location && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-faint">
                        <MapPin className="h-3 w-3 shrink-0" />
                        {e.location as string}
                      </p>
                    )}
                    {isHostedOnBatch0(e.live_mode) ? (
                      (s === "live" || s === "open") && (
                        <a
                          href={`/dashboard/events/${e.id}/live`}
                          className="press mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-phosphor px-3.5 text-[13px] font-semibold leading-none text-on-phosphor active:scale-[0.98]"
                        >
                          <Video className="h-3.5 w-3.5" />
                          Join
                        </a>
                      )
                    ) : (
                      joinUrl && (
                        <a
                          href={joinUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="press mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-phosphor px-3.5 text-[13px] font-semibold leading-none text-on-phosphor active:scale-[0.98]"
                        >
                          <Video className="h-3.5 w-3.5" />
                          Join
                        </a>
                      )
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        {(recordings.length > 0 || paged) && (
          <Section title={page > 1 ? "Older recordings" : "Recordings"}>
            {recordings.length === 0 ? (
              <Empty>No recordings on this page.</Empty>
            ) : (
              <div className="rounded-2xl border border-line px-4 sm:px-5">
                {recordings.map(({ e, href, external }) => (
                  <Row
                    key={e.id as string}
                    label={e.title as string}
                    meta={<LocalTime value={e.starts_at as string} mode="date" />}
                    href={href}
                    external={external}
                    prefetch={false}
                    right={
                      <Video className="h-[18px] w-[18px] shrink-0 text-ink-faint" />
                    }
                  />
                ))}
              </div>
            )}
            {paged && (
              <nav aria-label="Recordings pages" className="mt-4 flex justify-between gap-3">
                <PageLink href={page > 1 ? historyHref("/app/events", { page: page - 1, show: "all" }) : null}>
                  ← Newer
                </PageLink>
                <PageLink href={recordingPage.hasMore ? historyHref("/app/events", { page: page + 1, show: "all" }) : null}>
                  Older →
                </PageLink>
              </nav>
            )}
          </Section>
        )}
      </AppBody>
    </>
  );
}

/** Newer / Older, thumb-sized. A span when there's nowhere to go, so the pair never shifts. */
function PageLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  const shape =
    "inline-flex h-11 items-center rounded-xl border border-line px-4 text-[14px] font-medium";
  return href ? (
    <Link href={href} prefetch={false} className={`press ${shape} text-ink-soft active:bg-wash`}>
      {children}
    </Link>
  ) : (
    <span aria-disabled="true" className={`${shape} text-ink-faint opacity-60`}>
      {children}
    </span>
  );
}
