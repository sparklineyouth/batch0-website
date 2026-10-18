/**
 * A lesson's video and materials — pure rules, no imports, so `node --test`
 * runs it as-is (lib/lesson-assets.test.ts) and the player can share it.
 *
 * Files in the private `course-videos` / `course-materials` buckets are never
 * signed into the page any more. The page links to two routes that check the
 * viewer can read the lesson and sign at the moment of the request:
 *
 *   /dashboard/course/<lesson>/video                → the lesson's video
 *   /dashboard/course/<lesson>/materials?path=<p>   → one of its materials
 *
 * The page used to sign both for ten minutes at render, so a student who read
 * the lesson first and then clicked a worksheet (or pressed play) got an
 * expired-token error. The Resources page fixed the same thing the same way
 * (app/dashboard/resources/open/[id]/route.ts).
 */

/**
 * A material link opens at once, but a PDF viewer keeps fetching ranges while
 * you scroll, so not seconds. Same as a resource.
 */
export const MATERIAL_URL_TTL_SECONDS = 60 * 10;

/**
 * The player keeps requesting ranges of the file for as long as it plays,
 * each one checked against this. An hour covers a lecture in one go; when it
 * runs out mid-video the player asks the route again and carries on from the
 * same second (lesson-player.tsx). The URL never appears in the page itself.
 */
export const VIDEO_URL_TTL_SECONDS = 60 * 60;

export type LessonMaterial = { title: string; path: string };

/** `lessons.materials` jsonb → the entries that point at a file, in authored order. */
export function lessonMaterials(raw: unknown): LessonMaterial[] {
  if (!Array.isArray(raw)) return [];
  const out: LessonMaterial[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const path = (m as { path?: unknown }).path;
    if (typeof path !== "string" || !path.trim()) continue;
    const title = (m as { title?: unknown }).title;
    out.push({ title: typeof title === "string" && title.trim() ? title : path, path });
  }
  return out;
}

/**
 * The material the link named, if the lesson still lists it. Matched on the
 * storage path rather than a position, so a list reordered after the page
 * loaded still opens the file that was clicked — and one since removed opens
 * nothing.
 */
export function findMaterial(raw: unknown, path: string | null | undefined): LessonMaterial | null {
  if (!path) return null;
  return lessonMaterials(raw).find((m) => m.path === path) ?? null;
}

export function lessonVideoHref(lessonId: string): string {
  return `/dashboard/course/${lessonId}/video`;
}

export function lessonMaterialHref(lessonId: string, path: string): string {
  return `/dashboard/course/${lessonId}/materials?path=${encodeURIComponent(path)}`;
}

/** Why a material link came back to the lesson instead of opening (`?material=`). */
export type MaterialProblem = "missing" | "unavailable";

export function materialProblem(value: unknown): MaterialProblem | null {
  return value === "missing" || value === "unavailable" ? value : null;
}

// ---------------------------------------------------------------------------
// Picking up where you left off
// ---------------------------------------------------------------------------

/** Less than this in, and starting over loses nothing. */
export const MIN_RESUME_SECONDS = 5;
/** Within the last 15 seconds, or the last 5% of a long video, counts as finished. */
export const FINISHED_TAIL_SECONDS = 15;
export const FINISHED_TAIL_FRACTION = 0.05;

/**
 * Where a reopened lesson video starts, from the saved `watched_seconds`.
 *
 * Zero when there's nothing worth resuming (a few seconds in) and when the
 * student had all but finished — reopening a finished video at its credits is
 * never what anyone wants. Otherwise the saved second, clamped inside the
 * video: a saved position past the end (the file was replaced by a shorter
 * cut) starts over. `duration` is the file's own, which only the player knows
 * (NaN/Infinity until it has read the file). Not `lessons.duration_seconds`:
 * that's typed by hand in /admin/course, and a wrong one would skip a real
 * resume, or zero one the player then couldn't put back.
 */
export function resumePosition(saved: number | null | undefined, duration?: number | null): number {
  const s = typeof saved === "number" && Number.isFinite(saved) ? Math.floor(saved) : 0;
  if (s < MIN_RESUME_SECONDS) return 0;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return s;
  const tail = Math.max(FINISHED_TAIL_SECONDS, duration * FINISHED_TAIL_FRACTION);
  if (s >= duration - tail) return 0;
  return Math.min(s, Math.floor(duration));
}

/** How long the player waits for its own read of the saved second before trusting the page's. */
export const RESUME_READ_TIMEOUT_MS = 4000;

/**
 * The saved second to resume from: the player's own read of lesson_progress
 * when it got one, else what the page rendered with. The page's can be old —
 * Back/Forward shows the router cache's copy from the first visit, so a
 * student who watched to 10:00, opened the assignment and pressed Back would
 * otherwise get the "0" that page was first rendered with, and the next save
 * would write over 10:00. `fromRead` null = the read failed or timed out.
 */
export function latestSavedSeconds(fromPage: number | null | undefined, fromRead: number | null): number {
  const pick = fromRead ?? fromPage;
  return typeof pick === "number" && Number.isFinite(pick) && pick > 0 ? Math.floor(pick) : 0;
}

/** How far the playhead must move before the periodic save writes again. */
export const SAVE_EVERY_SECONDS = 10;

/**
 * Whether the playhead has moved far enough from the last saved second to
 * write it. Either direction: rewinding to rewatch an earlier part is a new
 * place to resume from, not a step to ignore until it passes the old one.
 * `flush` (pausing, leaving the page) writes any whole-second change.
 */
export function shouldSavePosition(current: number, lastSaved: number, flush = false): boolean {
  if (!Number.isFinite(current) || current < 0) return false;
  const moved = Math.abs(Math.floor(current) - Math.floor(lastSaved));
  return flush ? moved >= 1 : moved >= SAVE_EVERY_SECONDS;
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatPlayhead(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
