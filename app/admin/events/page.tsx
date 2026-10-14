import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { presentHosts } from "@/lib/live-rooms";
import { PEER_TIMEOUT_MS } from "@/lib/live-signal";
import { normalizeAudienceMode } from "@/lib/webinars";
import {
  adminGroup,
  isEventType,
  pickDefaultCohort,
  roomActionLabel,
} from "@/lib/event-form";
import { EventsAdmin } from "./events-admin";
import { recordedEventIds } from "./recordings";
import type { AdminEventRow, CohortOption } from "./types";

export const metadata = { title: "Events · Admin" };

// Live state is time-sensitive.
export const dynamic = "force-dynamic";

const COLUMNS =
  "id, title, description, type, cohort_id, starts_at, ends_at, location, zoom_url, recording_url, visibility, live_mode, audience_mode, auto_record, auto_share, live_started_at, live_ended_at";

export default async function AdminEventsPage(props: {
  searchParams: Promise<{ edit?: string }>;
}) {
  await requirePermission("events.manage");
  const { edit } = await props.searchParams;
  const admin = createAdminClient();
  const now = new Date();

  const [{ data: events, error }, { data: cohortRows }] = await Promise.all([
    admin.from("events").select(COLUMNS).order("starts_at", { ascending: false }).limit(300),
    admin
      .from("cohorts")
      .select("id, name, starts_on, ends_on, status")
      .order("starts_on", { ascending: false, nullsFirst: false }),
  ]);

  const cohorts: CohortOption[] = (cohortRows ?? [])
    .filter((c: any) => c.status !== "cancelled")
    .map((c: any) => ({ id: c.id, name: c.name }));
  const cohortName = new Map((cohortRows ?? []).map((c: any) => [c.id, c.name as string]));
  const defaultCohortId = pickDefaultCohort(
    (cohortRows ?? []).map((c: any) => ({
      id: c.id,
      startsOn: c.starts_on,
      endsOn: c.ends_on,
      status: c.status,
    })),
    now,
  );

  const rowsRaw = (events ?? []) as any[];
  const timing = (e: any) => ({
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    liveStartedAt: e.live_started_at ?? null,
    liveEndedAt: e.live_ended_at ?? null,
  });
  // Legacy premiere rows run as hosted rooms.
  const hostedRow = (e: any) => e.live_mode === "hosted" || e.live_mode === "premiere";

  // Who is on air in rooms that could be running (started, or starting
  // within a day, and not over): "Join" vs "Start".
  const soon = now.getTime() + 24 * 60 * 60_000;
  const candidates = rowsRaw.filter(
    (e) =>
      hostedRow(e) &&
      new Date(e.starts_at).getTime() <= soon &&
      adminGroup(timing(e), now, true) === "live",
  );
  const presence = new Map<string, string[]>();
  await Promise.all(
    candidates.map(async (e) => {
      const hosts = await presentHosts(e.id, PEER_TIMEOUT_MS);
      if (hosts && hosts.length) presence.set(e.id, hosts.map((h) => h.userId));
    }),
  );
  const hostIds = [...new Set([...presence.values()].flat())];
  const names = new Map<string, string>();
  if (hostIds.length) {
    const { data: people } = await admin.from("profiles").select("id, full_name").in("id", hostIds);
    for (const p of (people ?? []) as any[]) names.set(p.id, p.full_name || "A host");
  }

  const grouped = rowsRaw.map((e) => {
    const onAir = presence.has(e.id);
    return { e, onAir, group: adminGroup(timing(e), now, onAir) };
  });

  // Past rows with a recording (either generation) or a recording link.
  const pastIds = grouped
    .filter((g) => g.group === "past" && hostedRow(g.e))
    .slice(0, 100)
    .map((g) => g.e.id);
  const recorded = await recordedEventIds(admin, pastIds);

  const rows: AdminEventRow[] = grouped.map(({ e, onAir, group }) => ({
    id: e.id,
    title: e.title,
    description: e.description ?? null,
    type: isEventType(e.type) ? e.type : "other",
    cohortId: e.cohort_id ?? null,
    cohortName: e.cohort_id ? (cohortName.get(e.cohort_id) ?? null) : null,
    startsAt: e.starts_at,
    endsAt: e.ends_at ?? null,
    location: e.location ?? null,
    liveMode: hostedRow(e) ? "hosted" : "external",
    externalUrl: e.zoom_url ?? null,
    recordingUrl: e.recording_url ?? null,
    visibility: e.visibility === "public" || e.visibility === "staff" ? e.visibility : "enrolled",
    audienceMode: normalizeAudienceMode(e.audience_mode),
    autoRecord: !!e.auto_record,
    autoShare: !!e.auto_share,
    liveStartedAt: e.live_started_at ?? null,
    liveEndedAt: e.live_ended_at ?? null,
    group,
    roomAction: hostedRow(e) ? roomActionLabel(group, onAir, timing(e), now) : null,
    hosting: (presence.get(e.id) ?? []).map((id) => names.get(id) ?? "A host"),
    hasRecording: recorded.has(e.id) || !!e.recording_url,
  }));

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="font-display text-3xl text-ink">Events</h1>
      {error ? (
        <p className="mt-6 text-sm text-ink-soft">Couldn&rsquo;t load events. Reload to try again.</p>
      ) : (
        <div className="mt-6">
          <EventsAdmin
            rows={rows}
            cohorts={cohorts}
            defaultCohortId={defaultCohortId}
            now={now.toISOString()}
            initialEditId={typeof edit === "string" ? edit : null}
          />
        </div>
      )}
    </div>
  );
}
