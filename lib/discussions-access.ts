// ---------------------------------------------------------------------------
// Discussions — who may read a thread. Pure, dependency-free, so it can be
// tested and so the same predicate runs in a server component, a server
// action, and (in spirit) the RLS function `can_read_discussion()` in
// migration 0068. Keep the three in lockstep.
// ---------------------------------------------------------------------------

export type DiscussionVisibility = "cohort" | "admin";
export type DiscussionStatus = "open" | "closed";

export type ThreadScope = {
  visibility: DiscussionVisibility;
  cohortId: string | null;
  authorId: string;
};

export type DiscussionViewer = {
  userId: string;
  /** Holds `discussions.manage` (or the '*' wildcard). */
  manages: boolean;
  /** Every cohort the viewer is enrolled in. */
  cohortIds: readonly string[];
};

/**
 * The one rule. A private question (`admin`) is readable by its author and
 * the team, full stop — enrolment in the same cohort grants nothing. A cohort
 * discussion is readable by the team, its author, and anyone enrolled in the
 * cohort it was posted to.
 */
export function canReadThread(
  thread: ThreadScope,
  viewer: DiscussionViewer,
): boolean {
  if (viewer.manages) return true;
  if (thread.authorId === viewer.userId) return true;
  if (thread.visibility !== "cohort") return false;
  return thread.cohortId != null && viewer.cohortIds.includes(thread.cohortId);
}

/**
 * Whether a viewer may post a reply. Reading is necessary; the thread also
 * has to be open. Closed threads are read-only for everyone, the team
 * included — reopen first, so the state on the page is never a lie.
 */
export function canReplyToThread(
  thread: ThreadScope & { status: DiscussionStatus },
  viewer: DiscussionViewer,
): boolean {
  return thread.status === "open" && canReadThread(thread, viewer);
}

/** The status word a reader should see, by what kind of thread it is. */
export function closedLabel(visibility: DiscussionVisibility): string {
  return visibility === "admin" ? "Resolved" : "Locked";
}

export const THREAD_TITLE_MAX = 160;
export const THREAD_BODY_MAX = 8000;
