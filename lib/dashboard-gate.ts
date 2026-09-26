/**
 * Which /dashboard paths a viewer WITHOUT `student.dashboard` is bounced out
 * of — the rule behind the middleware's redirect to a mentor's or investor's
 * own home.
 *
 * /dashboard is the participant area, and a mentor or investor has no
 * business in the student view. Three kinds of page under it are not the
 * student view, though, and every role must be able to reach them:
 *
 *   - /dashboard/pay-fine and /dashboard/billing — per-user pages every role
 *     has (the fine block forces people to the first).
 *   - /dashboard/calls/<id>/live — the 1:1 ROOM, which is shared by both
 *     people on the call. The host of a call is very often a mentor or an
 *     investor, whose calls list (/mentor/calls, /investor/calls) links here,
 *     as does the invite's .ics. Bouncing them to /mentor meant a host could
 *     never enter their own call: the student sat alone in the room being told
 *     the call was recorded, and nothing was, because only the host's browser
 *     records. The page itself 404s anyone who is not one of the two people on
 *     that call, and the dashboard layout renders bare chrome (no student nav)
 *     for a viewer without `student.dashboard`.
 *
 * Only the room — not /dashboard/calls, which is the student's inbox and would
 * show a mentor an empty page.
 *
 * Pure and import-free, because middleware imports it (Edge) and
 * lib/dashboard-gate.test.ts runs it under plain `node --test`.
 */

/** The 1:1 room, `/dashboard/calls/<id>/live` (a trailing slash allowed). */
export function isCallRoomPath(path: string): boolean {
  return /^\/dashboard\/calls\/[^/]+\/live\/?$/.test(path);
}

/**
 * Should this /dashboard request be sent to the viewer's own home instead?
 *
 * `home` is where they would be sent; a role with no permissions at all
 * resolves its home to /dashboard, and bouncing /dashboard at /dashboard
 * would spin forever — the dashboard layout renders bare chrome for those
 * viewers instead, which is a dead end rather than a loop.
 */
export function bouncesFromDashboard({
  path,
  studentDashboard,
  home,
}: {
  path: string;
  studentDashboard: boolean;
  home: string;
}): boolean {
  if (!path.startsWith("/dashboard")) return false;
  if (studentDashboard) return false;
  if (home === "/dashboard") return false;
  if (path.startsWith("/dashboard/pay-fine")) return false;
  if (path.startsWith("/dashboard/billing")) return false;
  if (isCallRoomPath(path)) return false;
  return true;
}
