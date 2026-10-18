import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  eventCohortIds,
  eventVisibilityScopes,
  historyRange,
  recordingOrFilter,
  takePage,
} from "@/lib/event-history";

/**
 * Cached reads for the installed app.
 *
 * The app is four tabs people move between constantly, and every screen is
 * `force-dynamic` against a single-region Postgres that is a cross-region hop
 * away. Re-running the same syllabus query every time someone taps Course is
 * the bulk of what made the app feel slow. Paired with the prefetcher
 * (components/app/prefetch.tsx), these entries are usually already warm before
 * the user asks for the screen — which is the whole "nothing needs to load"
 * story.
 *
 * WHAT IS CACHED HERE, AND WHAT IS DELIBERATELY NOT
 *
 * Only content that is authored by staff and read by everyone: the course
 * syllabus, the events calendar, announcements. These change a few times a
 * cohort, so a minute of staleness is invisible.
 *
 * Deliberately NOT cached, and this is the important half: the application
 * review queue, pending charges, assignment status, revenue.
 * Those drive decisions about money and about people's places in the program,
 * they change in response to the very actions taken in this app, and a stale
 * one is not a slow screen — it is a wrong one. An admin who accepts an
 * applicant and still sees them in the queue will accept them twice.
 *
 * KEYING IS A SECURITY BOUNDARY. unstable_cache keys on the array passed as the
 * second argument, NOT on the closure's variables. Every value a query filters
 * by must appear in that array or one viewer will be served another's cache
 * entry. Everything below is keyed by cohort id (events by the sorted set of
 * cohorts the viewer is enrolled in), and none of it is per-user — it is the
 * same rows for every member of a cohort, which is precisely why it is safe
 * to share.
 */

/** A minute. Long enough to cover a burst of tab-switching, short enough that a
 *  newly published announcement shows up while the admin is still watching. */
const CONTENT_TTL = 60;

/** Bust every cached content read for a cohort. */
export const cohortContentTag = (cohortId: string) => `app-content:${cohortId}`;

/** Bust cohort-agnostic content (announcements and events with no cohort). */
export const GLOBAL_CONTENT_TAG = "app-content:global";

type CohortScope = { cohortId: string | null };

/**
 * PostgREST filter for "belongs to this cohort, or to everyone".
 *
 * Built here rather than inline so the cache key and the query can never
 * disagree about what was fetched.
 */
function scopeTags({ cohortId }: CohortScope): string[] {
  return cohortId
    ? [cohortContentTag(cohortId), GLOBAL_CONTENT_TAG]
    : [GLOBAL_CONTENT_TAG];
}

export type SyllabusModule = {
  id: string;
  week: number;
  title: string;
  summary: string | null;
  lessons: { id: string; title: string; duration_seconds: number | null }[];
};

/**
 * The whole syllabus for a cohort: modules with their lessons nested.
 *
 * The single most expensive read in the app and the most static — a syllabus is
 * authored once and edited rarely. Note this carries NO per-student state;
 * lesson_progress is fetched separately and uncached, because that changes
 * every time a student finishes a video and seeing your own progress lag by a
 * minute would read as the app losing your work.
 */
export function getSyllabus(cohortId: string): Promise<SyllabusModule[]> {
  return unstable_cache(
    async () => {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from("modules")
        .select(
          "id, week, title, summary, position, lessons(id, title, duration_seconds, position)",
        )
        .eq("cohort_id", cohortId)
        .order("week", { ascending: true })
        .order("position", { ascending: true })
        .order("position", { ascending: true, referencedTable: "lessons" });
      // Returning [] on error would be cached for a minute and render as "no
      // modules published yet" — a lie that outlives the blip. Throwing lets
      // the caller decide, and nothing gets stored.
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as SyllabusModule[];
    },
    ["app-syllabus", cohortId],
    { revalidate: CONTENT_TTL, tags: [cohortContentTag(cohortId)] },
  )();
}

export type AppEvent = {
  id: string;
  title: string;
  type: string;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  live_mode: string | null;
  zoom_url: string | null;
  recording_url: string | null;
  live_started_at: string | null;
  live_ended_at: string | null;
  /** When the follow-up (or an admin) shared the recording and slides. */
  assets_shared_at?: string | null;
};

const EVENT_COLUMNS =
  "id, title, type, description, starts_at, ends_at, location, live_mode, zoom_url, recording_url, live_started_at, live_ended_at, assets_shared_at";

/**
 * Whose events: every cohort the viewer is ENROLLED in (enrolledCohortIds in
 * lib/access.ts), which is what the `events read` policy opens. Not
 * StudentAccess.cohortId: that one cohort can be one they are only accepted
 * into, and it leaves out a returning student's earlier cohort (see
 * eventCohortIds in lib/event-history.ts).
 */
type EventScope = { cohortIds: readonly string[] };

/**
 * The scope as the queries, the cache key and the tags all see it, built
 * once so they can never disagree about what was fetched.
 */
function eventScope({ cohortIds }: EventScope) {
  const ids = eventCohortIds(cohortIds);
  return {
    // The visibility branches for the service-role reads below, which bypass
    // the policy, so these filters are what enforce it here.
    scopes: eventVisibilityScopes(ids),
    key: ids.length > 0 ? ids.join(",") : "none",
    tags: [...ids.map(cohortContentTag), GLOBAL_CONTENT_TAG],
  };
}

/** Either client: the service role (scoped by `scopes`) or the viewer's own (scoped by RLS). */
type EventsDb = Pick<ReturnType<typeof createAdminClient>, "from">;

/**
 * Upcoming events, reaching back a day so a session that is running (or that
 * a host started early) still shows. `scopes` are the visibility branches a
 * service-role read must apply itself; null is the viewer's own client, where
 * the `events read` policy does.
 */
function upcomingEvents(db: EventsDb, scopes: readonly string[] | null, nowIso: string) {
  const since = new Date(new Date(nowIso).getTime() - 24 * 60 * 60_000).toISOString();
  let q = db.from("events").select(EVENT_COLUMNS);
  if (scopes) {
    const [pub, enrolled] = scopes;
    q = enrolled ? q.or(`${pub},and(${enrolled})`) : q.eq("visibility", "public");
  }
  return q.gte("starts_at", since).order("starts_at", { ascending: true }).limit(20);
}

/** One page of past events with something to watch, scoped as upcomingEvents is. */
function recordingEvents(db: EventsDb, scopes: readonly string[] | null, nowIso: string, page: number) {
  const { from, to } = historyRange(page);
  return (
    db
      .from("events")
      .select(EVENT_COLUMNS)
      // ONE .or(): visibility AND has-a-recording, spelled out as a flat
      // `or` of `and`s (recordingOrFilter), so nothing rests on how two
      // `or=` parameters combine. With no scopes it's the recording kinds
      // alone, and RLS does the rest.
      .or(recordingOrFilter(scopes ?? []))
      .lt("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to)
  );
}

/**
 * Upcoming events for a student's cohorts. "Upcoming" reaches back a day so
 * a session that is running (or that a host started early) still shows.
 *
 * Visibility mirrors the `events read` policy: enrolled events of the
 * cohorts they are enrolled in, and every public one.
 *
 * `nowBucket` is in the cache key on purpose. The query filters on "now", so
 * without it a cached entry would keep answering with a `now` from up to a
 * minute ago — harmless here, but the same mistake on a shorter TTL silently
 * shows an event as upcoming after it has started. Bucketing to the minute
 * makes the key honest about what was actually fetched.
 *
 * Past events are getCohortRecordings' job: this used to read the five newest
 * and the Events screen kept the recorded ones, so five recent sessions
 * without a recording hid every older one.
 */
export function getCohortEvents(
  scope: EventScope,
  nowIso: string,
): Promise<{ upcoming: AppEvent[] }> {
  const nowBucket = nowIso.slice(0, 16); // YYYY-MM-DDTHH:MM
  const { scopes, key, tags } = eventScope(scope);
  return unstable_cache(
    async () => {
      const up = await upcomingEvents(createAdminClient(), scopes, nowIso);
      if (up.error) throw new Error(up.error.message);
      return { upcoming: (up.data ?? []) as AppEvent[] };
    },
    ["app-events", key, nowBucket],
    { revalidate: CONTENT_TTL, tags },
  )();
}

/**
 * One page of the past events a student may watch, newest first
 * (lib/event-history.ts pages it; `hasMore` says an older page exists).
 *
 * The recording filter is part of the query, scoped the same way as above,
 * so paging walks every recording and nothing else. A hosted event matches
 * once its assets are shared; whether a take really exists is a per-request
 * read (recordedEventIds) the caller makes, so a page can come back a row or
 * two short of what it shows — never with a recording skipped.
 */
export function getCohortRecordings(
  scope: EventScope,
  nowIso: string,
  page: number,
): Promise<{ rows: AppEvent[]; hasMore: boolean }> {
  const nowBucket = nowIso.slice(0, 16);
  const { scopes, key, tags } = eventScope(scope);
  return unstable_cache(
    async () => {
      const { data, error } = await recordingEvents(createAdminClient(), scopes, nowIso, page);
      if (error) throw new Error(error.message);
      return takePage((data ?? []) as AppEvent[]);
    },
    // `page` is in the key: page 2 is different rows from page 1.
    ["app-recordings", key, nowBucket, String(page)],
    { revalidate: CONTENT_TTL, tags },
  )();
}

/*
 * STAFF PREVIEWS: the same two reads, through the viewer's own client.
 *
 * Staff open the app to see what students see, and getStudentAccess reports
 * them enrolled so they can. But they hold no enrollment rows, so the scope
 * above (enrolledCohortIds) left them public events only: no cohort's
 * sessions, no recordings — not what any student sees, and not what
 * /dashboard/events shows them. These ask with the viewer's session instead,
 * so the `events read` policy itself decides, exactly as /dashboard/events
 * does (staff see every event there; a speaker, their own).
 *
 * Nothing here can widen what a student sees: a student never takes this
 * path, and if one did, RLS would still show them only their own. Not
 * cached: unstable_cache can't read the session, and an entry keyed for
 * staff must never answer a student. Staff are few; a preview can afford
 * the round trip.
 */

/** getCohortEvents for staff previewing the app: what the `events read` policy shows them. */
export async function getPreviewEvents(nowIso: string): Promise<{ upcoming: AppEvent[] }> {
  const up = await upcomingEvents(await createClient(), null, nowIso);
  if (up.error) throw new Error(up.error.message);
  return { upcoming: (up.data ?? []) as AppEvent[] };
}

/** getCohortRecordings for staff previewing the app, scoped by the policy as getPreviewEvents is. */
export async function getPreviewRecordings(
  nowIso: string,
  page: number,
): Promise<{ rows: AppEvent[]; hasMore: boolean }> {
  const { data, error } = await recordingEvents(await createClient(), null, nowIso, page);
  if (error) throw new Error(error.message);
  return takePage((data ?? []) as AppEvent[]);
}

export type AppAnnouncement = {
  id: string;
  title: string;
  body: string;
  created_at: string;
};

/** Announcements for a cohort, newest first. */
export function getCohortAnnouncements(
  scope: CohortScope,
  limit: number,
): Promise<AppAnnouncement[]> {
  const { cohortId } = scope;
  return unstable_cache(
    async () => {
      const admin = createAdminClient();
      const q = admin
        .from("announcements")
        .select("id, title, body, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      const { data, error } = await (cohortId
        ? q.or(`cohort_id.is.null,cohort_id.eq.${cohortId}`)
        : q.is("cohort_id", null));
      if (error) throw new Error(error.message);
      return (data ?? []) as AppAnnouncement[];
    },
    // `limit` is in the key: the Home screen asks for 1 and the Announcements
    // screen asks for 30, and without it whichever ran first would answer both.
    ["app-announcements", cohortId ?? "none", String(limit)],
    { revalidate: CONTENT_TTL, tags: scopeTags(scope) },
  )();
}
