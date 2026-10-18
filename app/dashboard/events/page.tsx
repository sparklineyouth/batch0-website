import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, getProfile } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";
import { EventCard, type StudentEvent } from "@/components/live/event-card";
import { studentEventStatus } from "@/lib/event-form";
import { recordedEventIds } from "@/lib/event-recordings";
import {
  emptyHistoryMessage,
  historyHref,
  historyRange,
  needsRecordingLookup,
  parseHistoryPage,
  parseHistoryShow,
  pastHistoryRows,
  recordingLink,
  recordingOrFilter,
  takePage,
  visibleHistory,
  type HistoryShow,
} from "@/lib/event-history";

export const metadata = { title: "Events · batch0" };

/** DB row → the shape EventCard renders. */
function toStudentEvent(e: any): StudentEvent {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    type: e.type,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    location: e.location,
    // Legacy premiere rows run as hosted rooms; anything unknown is external.
    liveMode:
      e.live_mode === "hosted" || e.live_mode === "premiere" ? "hosted" : "external",
    externalUrl: e.zoom_url ?? null,
    recordingUrl: e.recording_url,
    hostName: null,
    liveEndedAt: e.live_ended_at ?? null,
    liveStartedAt: e.live_started_at ?? null,
  };
}

export default async function StudentEventsPage(props: {
  searchParams: Promise<{ page?: string | string[]; show?: string | string[] }>;
}) {
  await requireUser();
  const searchParams = await props.searchParams;
  // History pages, and can be narrowed to recordings (lib/event-history.ts).
  // It used to stop at the ten newest older events, so anything recorded
  // before them could not be reached from here at all.
  const page = parseHistoryPage(searchParams.page);
  const show = parseHistoryShow(searchParams.show);
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");
  // A paid Demo Day ticket opens this page without enrollment. What such a
  // viewer then SEES is decided by the events RLS policy (migration 0070):
  // the Demo Day event for their ticket's cohort, and nothing else.
  if (!access.enrolled && !access.demoDayTicket) {
    return (
      <LockedFeature
        title="Events"
        applicationStatus={access.applicationStatus}
      />
    );
  }
  const supabase = await createClient();

  const nowDate = new Date();
  // Upcoming, plus anything that started in the last day (it may still be
  // running, or a host may have gone live early).
  const since = new Date(nowDate.getTime() - 24 * 60 * 60_000).toISOString();
  // Older history, one page at a time with a row of lookahead (historyRange).
  // The recordings filter is in the query, not applied to a page afterwards,
  // so a run of unrecorded sessions can't push a recording off the list.
  // RLS scopes the rows, so the filter is just the two kinds of recording.
  const { from, to } = historyRange(page);
  let olderQuery = supabase
    .from("events")
    .select("*")
    .lt("starts_at", since)
    .order("starts_at", { ascending: false })
    // A tiebreak, so two sessions that started together can't swap places
    // between pages and show twice (or never).
    .order("id", { ascending: true })
    .range(from, to);
  if (show === "recordings") olderQuery = olderQuery.or(recordingOrFilter());
  const [{ data: recent }, { data: olderRows }] = await Promise.all([
    supabase
      .from("events")
      .select("*")
      .gte("starts_at", since)
      .order("starts_at", { ascending: true }),
    olderQuery,
  ]);
  const older = takePage(olderRows ?? []);

  const withStatus = (recent ?? []).map((e: any) => ({
    e,
    s: studentEventStatus(
      {
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        liveStartedAt: e.live_started_at ?? null,
        liveEndedAt: e.live_ended_at ?? null,
      },
      nowDate,
    ),
  }));
  const liveNow = withStatus.filter((x) => x.s === "live");
  const stillUpcoming = withStatus.filter((x) => x.s === "upcoming" || x.s === "open");
  // The last day's ended sessions lead page one; later pages are older history.
  const pastRows = pastHistoryRows(
    page,
    withStatus.filter((x) => x.s === "ended" || x.s === "past").reverse(),
    older.rows.map((e: any) => ({ e, s: "past" as const })),
  );
  // A hosted webinar's own recording plays on its room page once the
  // follow-up (or an admin) shared it. The ids are rows this reader can see.
  const recorded = await recordedEventIds(
    createAdminClient(),
    pastRows.filter(({ e }) => needsRecordingLookup(e)).map(({ e }) => e.id as string),
  );
  // A shared hosted event with no take yet matched the query but has nothing
  // to play, so the recordings view drops it here.
  const endedPast = visibleHistory(pastRows, show, recorded, ({ e }) => e);
  const recordingHref = (e: any) => {
    const link = recordingLink(e, recorded);
    return link && !link.external ? link.href : null;
  };
  const hasHistory = endedPast.length > 0 || older.hasMore || page > 1 || show !== "all";

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Events</h1>
      <p className="mt-1 text-sm text-ink-faint">
        {access.enrolled ? "Live sessions and Demo Day." : "Your Demo Day ticket is confirmed."}
      </p>

      {liveNow.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-red-500">
            Live now
          </h2>
          <div className="space-y-3">
            {liveNow.map(({ e, s }) => (
              <EventCard key={e.id} event={toStudentEvent(e)} upcoming={false} initialStatus={s} />
            ))}
          </div>
        </section>
      )}

      {page === 1 && (
        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
            Upcoming
          </h2>
          {stillUpcoming.length === 0 ? (
            <Card>
              <p className="text-sm text-ink-faint">Nothing scheduled yet.</p>
            </Card>
          ) : (
            <div className="space-y-3">
              {stillUpcoming.map(({ e, s }) => (
                <EventCard key={e.id} event={toStudentEvent(e)} upcoming initialStatus={s} />
              ))}
            </div>
          )}
        </section>
      )}

      {hasHistory && (
        <section className="mt-10" aria-labelledby="past-events">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
            <h2
              id="past-events"
              className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint"
            >
              {show === "recordings" ? "Recordings" : "Past"}
              {page > 1 && <span className="ml-2 tabular-nums">· Page {page}</span>}
            </h2>
            <ShowToggle show={show} />
          </div>
          {endedPast.length === 0 ? (
            <Card>
              <p className="text-sm text-ink-faint">
                {/* Not "No recordings yet." above an Older page that has some. */}
                {emptyHistoryMessage({ show, page, hasMore: older.hasMore })}
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {endedPast.map(({ e, s }) => (
                <EventCard
                  key={e.id}
                  event={toStudentEvent(e)}
                  upcoming={false}
                  initialStatus={s}
                  recordingHref={recordingHref(e)}
                />
              ))}
            </div>
          )}
          {(page > 1 || older.hasMore) && (
            <nav aria-label="Past events pages" className="mt-4 flex justify-between gap-2 text-xs text-ink-soft">
              <PageLink href={page > 1 ? historyHref("/dashboard/events", { page: page - 1, show }) : null}>
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                Newer
              </PageLink>
              <PageLink href={older.hasMore ? historyHref("/dashboard/events", { page: page + 1, show }) : null}>
                Older
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </PageLink>
            </nav>
          )}
        </section>
      )}
    </div>
  );
}

/** All past events, or only the ones with something to watch. Back to page one either way. */
function ShowToggle({ show }: { show: HistoryShow }) {
  const options: { value: HistoryShow; label: string }[] = [
    { value: "all", label: "All" },
    { value: "recordings", label: "Recordings" },
  ];
  return (
    <div className="flex gap-1 text-xs" role="group" aria-label="Show">
      {options.map((o) => (
        <Link
          key={o.value}
          href={historyHref("/dashboard/events", { page: 1, show: o.value })}
          prefetch={false}
          aria-current={o.value === show ? "true" : undefined}
          className={`press rounded-md border px-2.5 py-1 ${
            o.value === show
              ? "border-phosphor/40 bg-phosphor/10 font-medium text-phosphor-ink"
              : "border-line text-ink-soft hover:bg-wash"
          }`}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

/** Newer / Older. A span when there's nowhere to go, so the pair never shifts. */
function PageLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  const shape = "inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5";
  return href ? (
    <Link href={href} prefetch={false} className={`press ${shape} hover:bg-wash`}>
      {children}
    </Link>
  ) : (
    <span aria-disabled="true" className={`${shape} text-ink-faint`}>
      {children}
    </span>
  );
}
