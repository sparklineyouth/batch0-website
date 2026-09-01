/**
 * When to stop walking Resend's `emails.list()` pages.
 *
 * Its own file, with no imports, so it can be tested directly — the module that
 * uses it pulls in the Resend SDK and the env helpers, and neither belongs in a
 * unit test of a boolean.
 *
 * The endpoint takes no date filter, so trimming to the window the metrics page
 * displays is our job. Paging all the way to the cap and discarding most of it
 * is pure waste on any account with history, but an early exit that stops too
 * soon silently truncates the delivery funnel — the page would under-report and
 * look completely normal doing it. So the predicate is deliberately conservative
 * in the one direction that matters.
 */
export function stopPaging(state: {
  /** Does the API say there are more pages? */
  hasMore: boolean;
  /** Rows returned on this page. */
  batchSize: number;
  /** Rows inside the window across every page so far, including this one. */
  seenInWindow: number;
  /** Rows inside the window on this page alone. */
  inWindowThisPage: number;
}): boolean {
  if (!state.hasMore || state.batchSize === 0) return true;
  // A page with nothing in the window only means "we've gone past it" once
  // we've actually been inside it. Before that, it means we haven't arrived
  // yet — which is what a newest-last ordering looks like from here.
  return state.seenInWindow > 0 && state.inWindowThisPage === 0;
}
