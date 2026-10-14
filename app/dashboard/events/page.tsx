import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";
import { EventCard } from "@/components/live/event-card";
import type { LiveEvent } from "@/lib/live";
import { studentEventStatus } from "@/lib/event-form";

export const metadata = { title: "Events · batch0" };

/** DB row → the shape EventCard renders. */
function toLiveEvent(e: any): LiveEvent & { liveStartedAt: string | null } {
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
    displayViewerCount: null,
    roomName: null,
    roomUrl: null,
    liveEndedAt: e.live_ended_at ?? null,
    liveStartedAt: e.live_started_at ?? null,
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
  // Upcoming, plus anything that started in the last day (it may still be
  // running, or a host may have gone live early).
  const since = new Date(nowDate.getTime() - 24 * 60 * 60_000).toISOString();
  const [{ data: recent }, { data: older }] = await Promise.all([
    supabase
      .from("events")
      .select("*")
      .gte("starts_at", since)
      .order("starts_at", { ascending: true }),
    supabase
      .from("events")
      .select("*")
      .lt("starts_at", since)
      .order("starts_at", { ascending: false })
      .limit(10),
  ]);

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
  const liveNow = withStatus.filter((x) => x.s === "live").map((x) => x.e);
  const stillUpcoming = withStatus
    .filter((x) => x.s === "upcoming" || x.s === "open")
    .map((x) => x.e);
  const endedPast = [
    ...withStatus
      .filter((x) => x.s === "ended" || x.s === "past")
      .map((x) => x.e)
      .reverse(),
    ...(older ?? []),
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Events</h1>
      <p className="mt-1 text-sm text-ink-faint">
        {access.enrolled ? "Live sessions, office hours, Demo Day." : "Your Demo Day ticket is confirmed."}
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
