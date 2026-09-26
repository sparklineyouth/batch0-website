import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";
import { EventCard } from "@/components/live/event-card";
import { eventLiveStatus, type LiveEvent } from "@/lib/live";

export const metadata = { title: "Events · batch0" };

/**
 * DB row -> the shape EventCard renders.
 *
 * Kept explicit rather than passing the row through, so a column rename shows
 * up as a type error here instead of an empty card in front of a student.
 */
function toLiveEvent(e: any): LiveEvent {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    type: e.type,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    location: e.location,
    // Rows written before migration 0058 have no live_mode; they are all
    // external by definition, so default rather than render them broken.
    // Narrowed rather than passed through, so a value this build does not know
    // about renders as an ordinary external event instead of as a room nobody
    // can enter.
    liveMode:
      e.live_mode === "hosted" || e.live_mode === "premiere"
        ? e.live_mode
        : "external",
    // The card only ever offers this for an external event; see EventCard.
    externalUrl: e.zoom_url ?? null,
    recordingUrl: e.recording_url,
    hostName: null,
    displayViewerCount: e.display_viewer_count ?? null,
    roomName: e.daily_room_name ?? null,
    roomUrl: e.daily_room_url ?? null,
    // Selected by the `*` below. Absent on a database that predates 0084,
    // where nothing can have been ended, so null is the honest default.
    liveEndedAt: e.live_ended_at ?? null,
  };
}

export default async function StudentEventsPage() {
  await requireUser();
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
  const now = nowDate.toISOString();
  const [{ data: upcoming }, { data: past }] = await Promise.all([
    supabase
      .from("events")
      .select("*")
      .gte("starts_at", now)
      .order("starts_at", { ascending: true }),
    supabase
      .from("events")
      .select("*")
      .lt("starts_at", now)
      .order("starts_at", { ascending: false })
      .limit(10),
  ]);

  // An event that has already started sorts into `past` by its start time, but
  // if its join window is still open it is happening RIGHT NOW — not over. Pull
  // those out so a live webinar shows under "Live now" with a Join button
  // instead of being buried, looking finished, in "Past".
  //
  // `eventLiveStatus` reads `live_ended_at` before the clock, so a webinar the
  // host ended at 7:40 goes to Past at 7:40 — it used to sit under "Live now"
  // with a Join button until ends_at + 30 minutes. An event ended before its
  // own start time (a rehearsal someone closed) leaves Upcoming the same way.
  const status = (e: any) =>
    eventLiveStatus(
      {
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        liveEndedAt: e.live_ended_at ?? null,
      },
      nowDate,
    );
  const isOver = (e: any) => {
    const s = status(e);
    return s === "ended" || s === "past";
  };
  const liveNow = (past ?? []).filter((e: any) => !isOver(e));
  const stillUpcoming = (upcoming ?? []).filter((e: any) => !isOver(e));
  const endedPast = [
    ...(upcoming ?? []).filter(isOver),
    ...(past ?? []).filter(isOver),
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Events</h1>
      <p className="mt-1 text-sm text-ink-faint">
        {access.enrolled
          ? "Demo Day, office hours, workshops."
          : "Your Demo Day ticket is confirmed — the event is below."}
      </p>

      {liveNow.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-red-500">
            Live now
          </h2>
          <div className="space-y-3">
            {liveNow.map((e: any) => (
              <EventCard key={e.id} event={toLiveEvent(e)} upcoming={false} />
            ))}
          </div>
        </section>
      )}

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
            {stillUpcoming.map((e: any) => (
              <EventCard key={e.id} event={toLiveEvent(e)} upcoming />
            ))}
          </div>
        )}
      </section>

      {endedPast.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
            Past
          </h2>
          <div className="space-y-3">
            {endedPast.map((e: any) => (
              <EventCard key={e.id} event={toLiveEvent(e)} upcoming={false} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
