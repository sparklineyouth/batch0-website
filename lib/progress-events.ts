/**
 * Progress events — the pure half of lib/progress.ts. No imports, so
 * `node --test` runs it as-is (lib/progress-events.test.ts).
 *
 * Both progress views build their events here, so the per-student page and
 * the roster can't disagree about what counts as activity.
 */

export type ProgressArea = "course" | "flow" | "resource" | "challenge" | "assignment";

/** One thing the student did, normalised across the five source tables. */
export type ProgressEvent = {
  area: ProgressArea;
  /** What they were on — a lesson title, a flow step, a resource name. */
  label: string;
  /** Extra qualifier: "3m watched", "step 2 of 5", "submitted". */
  detail?: string;
  at: string;
  /** True when this represents finishing something rather than pausing in it. */
  complete: boolean;
  href?: string;
};

/**
 * Rank events into a single "here's where they are" answer.
 *
 * Most-recent-first, with one deliberate tie-break: an *incomplete* event
 * beats a complete one at the same timestamp. If a student finished lesson 3
 * and started lesson 4 in the same minute, "started lesson 4" is the useful
 * answer to where they stopped — "finished lesson 3" describes where they
 * were a moment earlier.
 */
export function pickStoppedAt(events: ProgressEvent[]): ProgressEvent | null {
  if (events.length === 0) return null;
  return [...events].sort((a, b) => {
    const d = new Date(b.at).getTime() - new Date(a.at).getTime();
    if (d !== 0) return d;
    if (a.complete !== b.complete) return a.complete ? 1 : -1;
    return 0;
  })[0];
}

export function sortRecent(events: ProgressEvent[], limit = 12): ProgressEvent[] {
  return [...events]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);
}

/** "4m 12s watched" — reads better than a raw second count on a roster. */
export function formatWatched(seconds: number): string {
  if (seconds < 60) return `${seconds}s watched`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m watched` : `${m}m ${s}s watched`;
}

/** PostgREST returns a to-one embed as an object, or as an array of one. */
function embedTitle(value: unknown): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  const title = (row as { title?: unknown } | null | undefined)?.title;
  return typeof title === "string" && title ? title : null;
}

export type ChallengeSubmissionRow = {
  created_at: string;
  submitted_at?: string | null;
  challenge?: unknown;
};

/** A challenge entry (drafts are filtered out by the query). */
export function challengeEvent(r: ChallengeSubmissionRow): ProgressEvent {
  return {
    area: "challenge",
    label: embedTitle(r.challenge) ?? "a weekly challenge",
    detail: "submitted",
    // created_at is when the first draft autosaved, possibly days earlier.
    at: r.submitted_at ?? r.created_at,
    complete: true,
    href: "/admin/challenges",
  };
}

export type AssignmentSubmissionRow = {
  status: string;
  submitted_at?: string | null;
  updated_at: string;
  assignment?: unknown;
};

/**
 * A handed-in assignment. Excused rows are a staff decision, not something
 * the student did: the queries leave them out, and this returns null for one.
 */
export function assignmentEvent(r: AssignmentSubmissionRow): ProgressEvent | null {
  if (r.status === "excused") return null;
  return {
    area: "assignment",
    label: embedTitle(r.assignment) ?? "an assignment",
    detail:
      r.status === "returned"
        ? "returned for changes"
        : r.status === "reviewed"
          ? "reviewed"
          : "submitted",
    // When they handed it in, not when a mentor last touched the row.
    at: r.submitted_at ?? r.updated_at,
    complete: true,
    href: "/admin/assignments",
  };
}
