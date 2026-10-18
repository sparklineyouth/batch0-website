// ---------------------------------------------------------------------------
// batch0 Chat — how a list of messages is laid out on screen, as pure
// functions: day dividers, the "new messages" line, Discord-style grouping of
// consecutive messages from one person, typing lines, and merging a page or a
// live event into the list. Import-free so `node --test` runs it.
// ---------------------------------------------------------------------------

import { countsAsMessage, isAfter } from "./chat-access.ts";

/** What the layout needs from a message. */
export type Placeable = {
  id: string;
  senderId: string | null;
  kind: "message" | "system";
  createdAt: string;
  replyTo: unknown | null;
  pending?: boolean;
};

export type Row<M extends Placeable> =
  | { t: "day"; key: string; dayKey: string }
  | { t: "new"; key: string }
  | { t: "msg"; key: string; m: M; head: boolean };

/** Messages from one person within this window share one header. */
export const GROUP_WINDOW_MS = 7 * 60_000;

/**
 * The viewer's offset from UTC in minutes, as Date#getTimezoneOffset gives
 * it (minutes BEHIND UTC): one number, or the offset at each instant, which
 * is what a zone with daylight saving needs — a message sent at 00:30 in
 * October is still on October's side of midnight when it's read in November.
 */
export type Offset = number | ((epochMs: number) => number);

/** The browser's own offset at each instant. Pass this on the client; null on the server. */
export function localOffset(epochMs: number): number {
  return new Date(epochMs).getTimezoneOffset();
}

/**
 * A calendar day in the viewer's timezone, as YYYY-MM-DD. The offset is
 * passed in so tests are timezone-proof and the server render can skip
 * dividers; with localOffset each message gets its own day's offset.
 */
export function dayKey(iso: string, offset: Offset): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const minutes = typeof offset === "function" ? offset(t) : offset;
  return new Date(t - minutes * 60_000).toISOString().slice(0, 10);
}

/**
 * Lay out messages (oldest first). A header starts a new group when the
 * sender changes, the gap exceeds GROUP_WINDOW_MS, the message is a reply
 * (its quote needs the header), a day boundary passes, or the "new" line
 * falls between them. The "new" line goes before the first message from
 * someone else that's newer than the viewer's cursor — what the sidebar
 * counted as unread, so in #staff (`systemKey` "staff") its feed lines too
 * (countsAsMessage, the SQL's chat_counts_as_message).
 */
export function layoutMessages<M extends Placeable>(
  messages: readonly M[],
  opts: { viewerId: string; cursor: string | null; offsetMinutes: Offset | null; systemKey?: string | null },
): Row<M>[] {
  const rows: Row<M>[] = [];
  let prev: M | null = null;
  let prevDay: string | null = null;
  let newPlaced = !opts.cursor;
  for (const m of messages) {
    const day = opts.offsetMinutes === null ? null : dayKey(m.createdAt, opts.offsetMinutes);
    let boundary = false;
    if (day && day !== prevDay) {
      rows.push({ t: "day", key: `day-${day}`, dayKey: day });
      prevDay = day;
      boundary = true;
    }
    if (
      !newPlaced &&
      !m.pending &&
      countsAsMessage(m.kind, opts.systemKey ?? null) &&
      m.senderId !== opts.viewerId &&
      isAfter(m.createdAt, opts.cursor!)
    ) {
      rows.push({ t: "new", key: "new" });
      newPlaced = true;
      boundary = true;
    }
    const head =
      boundary ||
      !prev ||
      m.kind === "system" ||
      prev.kind === "system" ||
      prev.senderId !== m.senderId ||
      !!m.replyTo ||
      Date.parse(m.createdAt) - Date.parse(prev.createdAt) > GROUP_WINDOW_MS;
    rows.push({ t: "msg", key: m.id, m, head });
    prev = m;
  }
  return rows;
}

/** Stable posting order: by time, then id; pending (unsent) ones last. */
export function byTime<M extends { createdAt: string; id: string; pending?: boolean }>(a: M, b: M): number {
  if (!!a.pending !== !!b.pending) return a.pending ? 1 : -1;
  if (a.createdAt !== b.createdAt) return isAfter(a.createdAt, b.createdAt) ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** What merging needs from a message. */
type Mergeable = {
  id: string;
  createdAt: string;
  pending?: boolean;
  /** A send that didn't go through: kept, with its text, until Retry or Discard. */
  failed?: unknown;
  editedAt?: string | null;
  replyTo?: unknown;
  senderId?: string | null;
  /** The composer's id for the message (0104): an unsent bubble's, and the server copy's once it's in. */
  clientId?: string;
};

const isLocal = (m: Mergeable) => !!m.pending || !!m.failed;
const sentKey = (m: Mergeable) => (m.clientId && m.senderId ? `${m.senderId}:${m.clientId}` : null);

/**
 * Is this unsent or failed bubble a message the list already holds from the
 * server — the same author, the same client id (0104)? Then it went through,
 * whatever its own request said (the answer can be lost after the row
 * commits), and the server's copy is the one to show. Only the author and
 * the id decide: two messages with the same words have different ids and
 * stay two.
 */
export function settledBy(m: Mergeable, list: Iterable<Mergeable>): boolean {
  const key = isLocal(m) ? sentKey(m) : null;
  if (!key) return false;
  for (const x of list) if (x !== m && !isLocal(x) && sentKey(x) === key) return true;
  return false;
}

/** The bubbles in `list` the server's own copy in it settles (settledBy). */
function settledBubbles<M extends Mergeable>(list: readonly M[]): M[] {
  const sent = new Set<string>();
  for (const m of list) {
    const key = isLocal(m) ? null : sentKey(m);
    if (key) sent.add(key);
  }
  if (sent.size === 0) return [];
  return list.filter((m) => isLocal(m) && sent.has(sentKey(m) ?? ""));
}

/**
 * What the screen knows that a page can't. A page is a snapshot taken when
 * it was asked for; Realtime may have delivered a delete since, and the
 * snapshot would bring the message (and its words, in reply quotes) back.
 */
export type MergeGuard = {
  /** Ids this client has seen deleted. They stay gone, and quotes of them stay blank. */
  deleted?: ReadonlySet<string>;
};

/**
 * Merge incoming messages into a list: new ids are added, known ids take the
 * fresher copy, order is restored. A copy that says nothing new keeps the
 * object already on screen, and an edit seen live beats a page read before
 * it. An unsent or failed bubble whose message has now arrived from the
 * server (settledBy) gives way to it, so one message shows once, whichever
 * way the server's copy came: the send's answer, the Realtime echo, a resync
 * or a page. Returns the same array when nothing changed, so React (and
 * every memoized row) can skip the render.
 */
export function mergeMessages<M extends Mergeable>(list: readonly M[], incoming: readonly M[], guard: MergeGuard = {}): M[] {
  if (incoming.length === 0) return list as M[];
  const byId = new Map(list.map((m) => [m.id, m]));
  let changed = false;
  for (const raw of incoming) {
    if (guard.deleted?.has(raw.id)) continue;
    const cur = byId.get(raw.id);
    const m = fresher(cur, withoutDeletedQuote(raw, guard.deleted));
    if (m !== cur) {
      byId.set(m.id, m);
      changed = true;
    }
  }
  if (!changed) return list as M[];
  for (const m of settledBubbles(Array.from(byId.values()))) byId.delete(m.id);
  return Array.from(byId.values()).sort(byTime);
}

function fresher<M extends Mergeable>(cur: M | undefined, next: M): M {
  if (!cur || cur === next) return next;
  if (sameData(cur, next)) return cur;
  if (cur.editedAt && (!next.editedAt || isAfter(cur.editedAt, next.editedAt))) return cur;
  return next;
}

/** A reply whose original was deleted on this screen: its quote stays blank. */
function withoutDeletedQuote<M extends Mergeable>(m: M, deleted: ReadonlySet<string> | undefined): M {
  const q = m.replyTo as { id?: unknown; preview?: unknown; deleted?: unknown } | null | undefined;
  if (!deleted || !q || typeof q !== "object" || typeof q.id !== "string" || !deleted.has(q.id)) return m;
  if (q.deleted === true && !q.preview) return m;
  return { ...m, replyTo: { ...q, preview: "", deleted: true } };
}

/**
 * Structural equality for the plain, JSON-shaped data a server action
 * returns. A resync's copy of an unchanged message is a new object with the
 * same contents; this is how it's recognized as unchanged.
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameData(v, b[i]));
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && sameData(ra[k], rb[k]));
}

/**
 * Reconcile the newest page from the server with what's on screen: anything
 * on screen that the server should have returned but didn't (inside the
 * page's window, created before its snapshot) was deleted. Pending and
 * failed sends, and messages that arrived live after the snapshot, are kept
 * — except a send the page shows went through after all (settledBy).
 * The window's edge is the page's oldest row by (created_at, id) — the
 * order the server pages in — so a row tied on created_at with it but
 * sorting before it is outside the page, not deleted.
 */
export function reconcilePage<M extends Mergeable>(
  list: readonly M[],
  page: readonly M[],
  opts: { asOf: string; complete: boolean } & MergeGuard,
): M[] {
  const ids = new Set(page.map((m) => m.id));
  let oldest: M | null = null;
  for (const m of page) if (!oldest || byTime(m, oldest) < 0) oldest = m;
  const keep = list.filter(
    (m) =>
      m.pending ||
      !!m.failed ||
      ids.has(m.id) ||
      isAfter(m.createdAt, opts.asOf) ||
      (!opts.complete && oldest !== null && byTime(m, oldest) < 0),
  );
  const next = mergeMessages(keep, page, opts);
  const same = next.length === list.length && next.every((m, i) => m === list[i]);
  return same ? (list as M[]) : next;
}

/** "Maya is typing…", "Maya and Dev are typing…", "Several people are typing…" */
export function typingLine(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing…`;
  return "Several people are typing…";
}

/** Initials for an avatar: first letters of the first two words. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0])[0] ?? "?";
  const second = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";
  return (first + second).toUpperCase();
}

/** Is someone's message in a channel worth a mention highlight for this viewer? */
export function mentionsViewer(
  m: { mentions: readonly string[]; mentionEveryone: boolean; senderId: string | null },
  viewerId: string,
): boolean {
  if (m.senderId === viewerId) return false;
  return m.mentionEveryone || m.mentions.includes(viewerId);
}
