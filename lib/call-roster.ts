/**
 * A 1:1's roster while the call is running — who the room dials, and who is
 * on its staff side — kept current by the heartbeat.
 *
 * Until people could be added to a call that already exists, the roster a
 * browser joined with was the roster for the life of the call: `joinRoom`
 * handed each person everyone else on the invite, the engine dialled them,
 * and the page rendered the staff side (`callStaffIds` in lib/live.ts) once,
 * for the recorder election. Someone added while the call is running
 * (addCallCohosts) broke both halves of that:
 *
 *   - Dialling. In a mesh of broadcasters exactly one side of each pair
 *     offers — the smaller user id (`shouldOffer` in use-live-session.ts) —
 *     which is what makes glare impossible. A newcomer offers to everyone
 *     with a LARGER id than theirs, and those links come up. Everyone with a
 *     SMALLER id was meant to offer to them, had never heard of them, and
 *     never did: the newcomer sat on "Waiting for Ana to join" while Ana, in
 *     the same room, had no idea they were there.
 *   - The election. Each staff browser elects the call's recorder from the
 *     staff list its page rendered. The incumbent's list did not have the
 *     newcomer on it, so a lower-id co-host arriving never took the recording
 *     over: both browsers recorded, and only the server's backstop
 *     (getCallRecordingUploadToken) kept the call on tape once.
 *
 * So a call's heartbeat (announcePresence) now answers with the roster as the
 * server just read it, and the engine folds it in with these rules: anyone
 * new is appended to the peers it holds — dialled at once, and re-dialled by
 * every heartbeat after, exactly like someone named at join — and the staff
 * list the room elects from is replaced when, and only when, its membership
 * changed.
 *
 * Pure and import-free, so `node --test` runs it with no transpile step and
 * the rules are pinned in lib/call-roster.test.ts rather than living only in
 * an 1,800-line hook.
 */

/**
 * A peer as the engine holds it. Structurally `LivePeer` (lib/live-rooms.ts),
 * restated here because that module is server-only and this one must stay
 * importable by the test runner; the two are interchangeable.
 */
export type RosterPeer = {
  peerId: string;
  name: string;
  role: "host" | "viewer";
  /**
   * The private line between this browser's person and them, as the server
   * derived it from the room and the pair (callLineFor in lib/live-rooms.ts).
   * Never anything a browser could compute: the key is an HMAC under a secret
   * only the server holds.
   */
  inbox: string;
};

/**
 * Fold a heartbeat's roster into the peers a session already holds.
 *
 *   - Never self. A browser that dialled itself would hold a connection to
 *     nobody, offering into its own inbox on every heartbeat.
 *   - Everyone already known is kept exactly as they are, in their order. The
 *     server's copy of someone known is not news — a line is derived from
 *     the room and the pair, so it cannot have moved — and swapping the
 *     object would be churn under a link that may be mid-negotiation.
 *   - Someone new is appended in the server's order, and listed in `added`
 *     so the caller can dial exactly them.
 *   - Anything malformed is skipped: not an object, no `peerId`, no `inbox`
 *     (someone the engine has no way to reach), or a role it does not know.
 *     A server action should never answer with one; but a bad entry must not
 *     become a dead "waiting for…" tile in front of a student, and a tab that
 *     outlives a deploy may be talking to a server whose shape has moved.
 *     Only the four fields are copied, so nothing else the answer carried
 *     rides along into the engine.
 *
 * `added` is empty when nothing was new — a plain 1:1, on every heartbeat it
 * ever sends — and the caller then changes nothing at all. `peers` is always
 * a fresh array; neither input is modified.
 */
export function mergeCallPeers(
  known: readonly RosterPeer[],
  incoming: unknown,
  selfId: string,
): { peers: RosterPeer[]; added: RosterPeer[] } {
  const seen = new Set<string>(known.map((p) => p.peerId));
  if (selfId) seen.add(selfId);
  const added: RosterPeer[] = [];
  if (Array.isArray(incoming)) {
    for (const raw of incoming) {
      const peer = rosterPeer(raw);
      if (!peer || seen.has(peer.peerId)) continue;
      seen.add(peer.peerId);
      added.push(peer);
    }
  }
  return { peers: [...known, ...added], added };
}

/** One roster entry, validated and copied — or null when it is unusable. */
function rosterPeer(raw: unknown): RosterPeer | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.peerId !== "string" || !p.peerId) return null;
  if (typeof p.inbox !== "string" || !p.inbox) return null;
  if (p.role !== "host" && p.role !== "viewer") return null;
  return {
    peerId: p.peerId,
    name: typeof p.name === "string" ? p.name : "",
    role: p.role,
    inbox: p.inbox,
  };
}

/**
 * The staff list a heartbeat reported, cleaned — or null when it is not one
 * the room should act on.
 *
 * Strings only, empties and duplicates dropped, the server's order kept (the
 * host first, then co-hosts — callStaffIds). Null rather than an empty list
 * when nothing usable is left: every call has a host, so an empty staff side
 * can only be a malformed answer, and acting on it would tell every staff
 * browser it was no longer staff — standing the call's recorder down mid-call
 * over a bad payload. The engine ignores a null and keeps the list it had.
 */
export function normalizeStaffIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || !id || out.includes(id)) continue;
    out.push(id);
  }
  return out.length > 0 ? out : null;
}

/**
 * Do two staff lists name the same people?
 *
 * Blind to order and to repeats, because the staff side is a set: the
 * election takes the lowest id in it, and the counterpart test, End call's
 * confirm and the room's copy ask only who is in it and how many. A heartbeat
 * that lists the same people in another order — co-hosts added by one
 * statement share a `created_at`, and the tie can come back either way — is
 * not a change, and must not re-render a room every twelve seconds. Null is
 * "not heard yet", and equals only itself.
 */
export function sameStaffList(
  a: readonly string[] | null,
  b: readonly string[] | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/**
 * Is THIS browser on the call's staff side — one that may ever record?
 *
 * Asked of both lists, and both must agree:
 *
 *   rendered  The staff side the page rendered with. It says which side this
 *             person joined on, and that never goes stale for SELF: nothing
 *             moves anyone between the student and the team mid-call — people
 *             are only ever added, never the student (resolveCohosts drops
 *             them) — and the page 404s for anyone not on the call, so a
 *             co-host looking at it was already on the team when it rendered,
 *             and is on this list.
 *   live      The server's latest (null until the first heartbeat answers).
 *
 * So a roster from a heartbeat can make OTHER people staff — the co-host
 * added mid-call, who must count in the election and as the student's
 * counterpart — but it can never make the student's laptop a recorder,
 * whatever a heartbeat says. The student is a minor, and their browser
 * capturing the call is the one outcome no answer from the wire may cause.
 */
export function selfIsCallStaff({
  selfId,
  rendered,
  live,
}: {
  selfId: string;
  rendered: readonly string[];
  live: readonly string[] | null;
}): boolean {
  if (!selfId || !rendered.includes(selfId)) return false;
  return live === null || live.includes(selfId);
}
