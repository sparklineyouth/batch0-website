import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";

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
 * review queue, pending charges, check-in state, the at-risk list, revenue.
 * Those drive decisions about money and about people's places in the program,
 * they change in response to the very actions taken in this app, and a stale
 * one is not a slow screen — it is a wrong one. An admin who accepts an
 * applicant and still sees them in the queue will accept them twice.
 *
 * KEYING IS A SECURITY BOUNDARY. unstable_cache keys on the array passed as the
 * second argument, NOT on the closure's variables. Every value a query filters
 * by must appear in that array or one viewer will be served another's cache
 * entry. Everything below is keyed by cohort id, and none of it is per-user —
 * it is the same rows for every member of a cohort, which is precisely why it
 * is safe to share.
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
  location: string | null;
  zoom_url: string | null;
  recording_url: string | null;
};

/**
 * Upcoming and recent events for a cohort.
 *
 * `nowBucket` is in the cache key on purpose. The query filters on "now", so
 * without it a cached entry would keep answering with a `now` from up to a
 * minute ago — harmless here, but the same mistake on a shorter TTL silently
 * shows an event as upcoming after it has started. Bucketing to the minute
 * makes the key honest about what was actually fetched.
 */
export function getCohortEvents(
  scope: CohortScope,
  nowIso: string,
): Promise<{ upcoming: AppEvent[]; past: AppEvent[] }> {
  const nowBucket = nowIso.slice(0, 16); // YYYY-MM-DDTHH:MM
  const { cohortId } = scope;
  return unstable_cache(
    async () => {
      const admin = createAdminClient();
      const cols =
        "id, title, type, description, starts_at, location, zoom_url, recording_url";
      const base = () => {
        const q = admin.from("events").select(cols).in("visibility", ["enrolled", "public"]);
        return cohortId
          ? q.or(`cohort_id.is.null,cohort_id.eq.${cohortId}`)
          : q.is("cohort_id", null);
      };
      const [up, past] = await Promise.all([
        base()
          .gte("starts_at", nowIso)
          .order("starts_at", { ascending: true })
          .limit(20),
        base()
          .lt("starts_at", nowIso)
          .order("starts_at", { ascending: false })
          .limit(5),
      ]);
      if (up.error) throw new Error(up.error.message);
      if (past.error) throw new Error(past.error.message);
      return {
        upcoming: (up.data ?? []) as AppEvent[],
        past: (past.data ?? []) as AppEvent[],
      };
    },
    ["app-events", cohortId ?? "none", nowBucket],
    { revalidate: CONTENT_TTL, tags: scopeTags(scope) },
  )();
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
