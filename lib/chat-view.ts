// ---------------------------------------------------------------------------
// batch0 Chat — how a list of messages is laid out on screen, as pure
// functions: day dividers, the "new messages" line, Discord-style grouping of
// consecutive messages from one person, typing lines, and merging a page or a
// live event into the list. Import-free so `node --test` runs it.
// ---------------------------------------------------------------------------

import { isAfter } from "./chat-access.ts";

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
 * A calendar day in the viewer's timezone, as YYYY-MM-DD. `offsetMinutes`
 * is Date#getTimezoneOffset() (minutes BEHIND UTC), passed in so tests are
 * timezone-proof and the server render can skip dividers.
 */
export function dayKey(iso: string, offsetMinutes: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  return new Date(t - offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * Lay out messages (oldest first). A header starts a new group when the
 * sender changes, the gap exceeds GROUP_WINDOW_MS, the message is a reply
 * (its quote needs the header), a day boundary passes, or the "new" line
 * falls between them. The "new" line goes before the first message from
 * someone else that's newer than the viewer's cursor.
 */
export function layoutMessages<M extends Placeable>(
  messages: readonly M[],
  opts: { viewerId: string; cursor: string | null; offsetMinutes: number | null },
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
      m.kind === "message" &&
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

/**
 * Merge incoming messages into a list: new ids are added, known ids are
 * replaced by the fresher copy, order is restored. Returns the same array
 * when nothing changed, so React can skip the render.
 */
export function mergeMessages<M extends { id: string; createdAt: string; pending?: boolean }>(
  list: readonly M[],
  incoming: readonly M[],
): M[] {
  if (incoming.length === 0) return list as M[];
  const byId = new Map(list.map((m) => [m.id, m]));
  let changed = false;
  for (const m of incoming) {
    const cur = byId.get(m.id);
    if (cur !== m) {
      byId.set(m.id, m);
      changed = true;
    }
  }
  if (!changed) return list as M[];
  return Array.from(byId.values()).sort(byTime);
}

/**
 * Reconcile the newest page from the server with what's on screen: anything
 * on screen that the server should have returned but didn't (inside the
 * page's window, created before its snapshot) was deleted. Pending messages
 * and ones that arrived live after the snapshot are kept.
 */
export function reconcilePage<M extends { id: string; createdAt: string; pending?: boolean }>(
  list: readonly M[],
  page: readonly M[],
  opts: { asOf: string; complete: boolean },
): M[] {
  const ids = new Set(page.map((m) => m.id));
  const oldest = page[0]?.createdAt ?? null;
  const keep = list.filter(
    (m) =>
      m.pending ||
      ids.has(m.id) ||
      isAfter(m.createdAt, opts.asOf) ||
      (!opts.complete && oldest !== null && isAfter(oldest, m.createdAt)),
  );
  const next = mergeMessages(keep.filter((m) => !ids.has(m.id)), page);
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
