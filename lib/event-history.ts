/**
 * Past events and their recordings — paging and filtering rules, pure.
 *
 * Both students' events lists used to cut history short before deciding what
 * to show: /dashboard/events read the ten newest older events, and the
 * installed app read the five newest past ones and only THEN kept the ones
 * with a recording. A run of recent sessions without one hid every older
 * recording, with nothing to page to. Now the recording filter is part of the
 * query (recordingOrFilter) and history pages (historyRange), so every
 * recording a student may watch is reachable on both surfaces.
 *
 * No imports, so `node --test` runs it as-is.
 */

/** Rows per page of history, on both surfaces. */
export const EVENT_HISTORY_PAGE_SIZE = 10;

/**
 * The last page anyone may ask for. A cohort has a few dozen events; this only
 * stops a hand-typed `?page=99999999` from becoming an absurd OFFSET.
 */
export const EVENT_HISTORY_MAX_PAGE = 500;

export type HistoryShow = "all" | "recordings";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** `?page=` as a page number: 1 for anything missing or malformed. */
export function parseHistoryPage(raw: string | string[] | undefined): number {
  const v = (first(raw) ?? "").trim();
  if (!/^\d{1,6}$/.test(v)) return 1;
  const n = Number(v);
  return n < 1 ? 1 : Math.min(n, EVENT_HISTORY_MAX_PAGE);
}

/** `?show=` — "recordings" or everything. */
export function parseHistoryShow(raw: string | string[] | undefined): HistoryShow {
  return first(raw) === "recordings" ? "recordings" : "all";
}

/**
 * The inclusive `.range()` for one page, with ONE row of lookahead: a page
 * that comes back with `size + 1` rows has an older page after it, which is
 * how a list knows to offer "Older" without a separate count query.
 */
export function historyRange(
  page: number,
  size: number = EVENT_HISTORY_PAGE_SIZE,
): { from: number; to: number } {
  const from = (Math.max(1, page) - 1) * size;
  return { from, to: from + size };
}

/** Split a lookahead page into what to show and whether there is more. */
export function takePage<T>(
  rows: readonly T[],
  size: number = EVENT_HISTORY_PAGE_SIZE,
): { rows: T[]; hasMore: boolean } {
  return { rows: rows.slice(0, size), hasMore: rows.length > size };
}

/**
 * A list's own URL with the page and filter set. Page 1 and "all" are the
 * defaults and stay out of the URL, so the plain link is the canonical one.
 */
export function historyHref(base: string, opts: { page: number; show: HistoryShow }): string {
  const params = new URLSearchParams();
  if (opts.show === "recordings") params.set("show", "recordings");
  if (opts.page > 1) params.set("page", String(opts.page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The cohorts whose enrolled-only events a student may see: every cohort they
 * hold an enrollment row in, which is exactly the `events read` policy's
 * enrolled clause (migration 0098). Sorted and deduped, so the same student
 * always gets the same cache key; anything that is not a uuid is dropped,
 * because these go into a PostgREST filter string.
 *
 * Deliberately NOT StudentAccess.cohortId. That is one cohort, "where the
 * student is": the soonest one ahead of them, which can be a cohort they are
 * only accepted into (no enrollment, so RLS shows them none of its enrolled
 * events), and which drops a returning student's earlier cohort entirely.
 * Scoping the installed app's events by it showed the wrong cohort's
 * recordings and hid the right ones, while /dashboard/events (RLS) did not.
 */
export function eventCohortIds(ids: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    if (id && UUID_RE.test(id)) out.add(id.toLowerCase());
  }
  return Array.from(out).sort();
}

/**
 * The `events read` policy's visibility as PostgREST `and` lists: every
 * public event, and the enrolled events of these cohorts. For service-role
 * reads (lib/app-cache.ts), which bypass that policy, so these filters are
 * what enforce it there.
 */
export function eventVisibilityScopes(cohortIds: Iterable<string | null | undefined>): string[] {
  const ids = eventCohortIds(cohortIds);
  return ids.length > 0
    ? ["visibility.eq.public", `visibility.eq.enrolled,cohort_id.in.(${ids.join(",")})`]
    : ["visibility.eq.public"];
}

/** The hosted modes: the room is batch0's, and so is its recording. lib/webinars.ts. */
const HOSTED_MODES = ["hosted", "premiere"] as const;

/** A pasted recording link (YouTube, Drive, a Zoom cloud recording). */
const HAS_LINK = "recording_url.not.is.null";
/**
 * A hosted event whose follow-up (or an admin) has shared its assets: the one
 * way the room page's own recording becomes watchable. Whether a take really
 * exists is a second read (recordedEventIds, lib/event-recordings.ts), so a
 * row matching this is a candidate, not a promise.
 */
const MAY_PLAY_OWN = `assets_shared_at.not.is.null,live_mode.in.(${HOSTED_MODES.join(",")})`;

/**
 * The PostgREST `or=` value for "has something to watch", for `.or()`.
 *
 * `scopes` are the visibility branches the query must also satisfy, each an
 * `and` list (["visibility.eq.public", "visibility.eq.enrolled,cohort_id.eq.X"]).
 * With none, RLS is doing the scoping and the filter is just the two
 * recording kinds. With some, it is the product (scope AND kind) spelled out
 * as one flat `or` of `and`s, because a query may carry only one `.or()`
 * here: a second would have to be trusted to AND with the first.
 */
export function recordingOrFilter(scopes: readonly string[] = []): string {
  if (scopes.length === 0) return `${HAS_LINK},and(${MAY_PLAY_OWN})`;
  return scopes
    .flatMap((scope) => [`and(${scope},${HAS_LINK})`, `and(${scope},${MAY_PLAY_OWN})`])
    .join(",");
}

type RecordingFacts = {
  id: string;
  recording_url: string | null;
  live_mode: string | null;
  assets_shared_at?: string | null;
};

function isHosted(mode: string | null): boolean {
  return (HOSTED_MODES as readonly string[]).includes(mode ?? "");
}

/** Whether a past event's own recording has to be looked up (recordedEventIds). */
export function needsRecordingLookup(e: RecordingFacts): boolean {
  return !e.recording_url && isHosted(e.live_mode) && !!e.assets_shared_at;
}

/**
 * Where a past event's recording plays, or null when it has none: the pasted
 * link (a new tab), else the hosted room's own player once `recorded` (the
 * ids recordedEventIds found) says there is a take.
 */
export function recordingLink(
  e: RecordingFacts,
  recorded: ReadonlySet<string>,
): { href: string; external: boolean } | null {
  if (e.recording_url) return { href: e.recording_url, external: true };
  if (needsRecordingLookup(e) && recorded.has(e.id)) {
    return { href: `/dashboard/events/${encodeURIComponent(e.id)}/live`, external: false };
  }
  return null;
}

/**
 * One page of /dashboard/events' past list, before the recordings filter.
 * Page one leads with the last day's ended sessions (the upcoming query read
 * those; pass them newest first), then that page of older history. Later
 * pages are older history alone, so nothing shows on two pages.
 */
export function pastHistoryRows<T>(
  page: number,
  lastDayEnded: readonly T[],
  olderRows: readonly T[],
): T[] {
  return [...(page === 1 ? lastDayEnded : []), ...olderRows];
}

/**
 * What a past list shows: every row, or for "recordings" only the rows with
 * something to play. A shared hosted event with no take matched the query
 * (recordingOrFilter) but has nothing to play, so this is where it drops.
 */
export function visibleHistory<T>(
  rows: readonly T[],
  show: HistoryShow,
  recorded: ReadonlySet<string>,
  eventOf: (row: T) => RecordingFacts,
): T[] {
  return show === "recordings"
    ? rows.filter((r) => recordingLink(eventOf(r), recorded) !== null)
    : [...rows];
}

/**
 * The line an empty page of history shows. "No recordings yet." only when
 * there are none at all: a page whose rows were all dropped by visibleHistory
 * can still sit above an Older page that has real ones.
 */
export function emptyHistoryMessage(opts: {
  show: HistoryShow;
  page: number;
  hasMore: boolean;
}): string {
  if (opts.show === "all") return "Nothing older.";
  return opts.page > 1 || opts.hasMore ? "No recordings on this page." : "No recordings yet.";
}
