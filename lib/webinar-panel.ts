/**
 * The webinar side panel's state rules — chat feed, cursor, realtime hints,
 * optimistic writes. Pure (relative imports only) so `npm test` pins them.
 *
 * Model: the client keeps the SERVER's last answer (`PanelBase`) and a map of
 * optimistic edits (`Overrides`) on top. A read replaces or merges the base and
 * drops every override that settled before the read started — the read has
 * caught up with it. What is drawn is base + overrides. That one rule is what
 * makes a removal stick (the server never returns removed rows), keeps an
 * upvote from snapping back mid-flight, and lets a forged hint undo itself on
 * the next read.
 */
import {
  isReaction,
  type AudienceMode,
  type ChatMessage,
  type Reaction,
  type RoomQuestion,
  type WebinarPoll,
} from "./webinars.ts";
import type { RoomMessage } from "./live-signal.ts";

/** Newest messages a full read returns. */
export const CHAT_PAGE = 200;
/** Most messages a client holds; older ones fall off the top. */
export const CHAT_KEEP = 300;
/**
 * An incremental read re-reads this far behind its cursor. A row's
 * created_at is its transaction's start, so one can commit after a newer row
 * the client already holds; the overlap catches it, the merge dedupes.
 */
export const CHAT_CURSOR_OVERLAP_MS = 5_000;
/** Backstop re-read for a reader who holds no room topic (private-mode viewers). */
export const PANEL_POLL_NO_TOPIC_MS = 10_000;
/** How often an open People tab re-reads who is here. */
export const PEOPLE_POLL_MS = 10_000;

/** The feeds a hint names and a full read covers. */
export type PanelPart = "chat" | "qa" | "poll";
export const PANEL_PARTS: readonly PanelPart[] = ["chat", "qa", "poll"];
/** What a read may ask for: the feeds, plus the hosts' roster (People tab only). */
export type PanelReadPart = PanelPart | "people";
export const PANEL_READ_PARTS: readonly PanelReadPart[] = [...PANEL_PARTS, "people"];

export type PanelRole = "staff" | "speaker" | "viewer";
export type PanelTab = "chat" | "qa" | "polls" | "people";

/** One read, shaped for its reader by the server. Absent parts were not asked for. */
export type PanelRead = {
  audienceMode: AudienceMode;
  chat?: {
    /** Oldest first. */
    messages: ChatMessage[];
    pinned: ChatMessage | null;
    /** True: the newest CHAT_PAGE (truth). False: rows since the cursor. */
    full: boolean;
    /** Newest created_at returned, else the cursor that was asked from. */
    cursor: string | null;
  };
  questions?: RoomQuestion[];
  polls?: WebinarPoll[];
  /** Hosts only, and only when asked for. */
  people?: PanelPeople;
};

/**
 * Who is in the room, for a host. Names only — no ids. Excludes the reader.
 * `viewers` is null for a guest speaker, who is told how many, never who.
 */
export type PanelPeople = {
  hosts: string[];
  viewers: string[] | null;
  watching: number;
};

/** The server-rendered first read: every part, chat in full. */
export type WebinarPanelInitial = PanelRead & {
  chat: NonNullable<PanelRead["chat"]>;
  questions: RoomQuestion[];
  polls: WebinarPoll[];
};

/** Result of a panel write. `retryInMs` marks a refusal worth retrying (rate limit). */
export type PanelWrite<T = null> =
  | { ok: true; data: T }
  | { ok: false; error: string; retryInMs?: number };

// ---------------------------------------------------------------------------
// Writes: POST /api/live/panel
// ---------------------------------------------------------------------------

export type ChatModeration = "approve" | "remove" | "pin" | "unpin";
const CHAT_MODERATIONS: readonly ChatModeration[] = ["approve", "remove", "pin", "unpin"];
export const QUESTION_STATUSES = ["open", "answered", "dismissed"] as const;
export type QuestionState = (typeof QUESTION_STATUSES)[number];

/**
 * One panel write. Writes are a route rather than server actions for the
 * same reason reads are: Next runs a page's actions one at a time, so a send
 * would wait behind the engine's heartbeat.
 */
export type PanelOp =
  | { op: "chat.send"; id: string; body: string }
  | { op: "chat.delete"; id: string }
  | { op: "chat.moderate"; id: string; action: ChatModeration }
  | { op: "qa.ask"; id: string; body: string }
  | { op: "qa.vote"; id: string; on: boolean }
  | { op: "qa.spotlight"; id: string; on: boolean }
  | { op: "qa.status"; id: string; status: QuestionState }
  | { op: "qa.approve"; id: string }
  | {
      op: "poll.create";
      question: string;
      options: string[];
      resultsVisible: boolean;
      open: boolean;
    }
  | { op: "poll.open"; id: string; open: boolean }
  | { op: "poll.vote"; id: string; choice: number };

/** What each write answers with. */
export type PanelOpResult<K extends PanelOp["op"]> = K extends "chat.send"
  ? ChatMessage
  : K extends "qa.ask"
    ? RoomQuestion
    : K extends "poll.create"
      ? string
      : null;

/** Longest text field a write body may carry; the normalisers cut tighter. */
const MAX_FIELD = 4_000;
const MAX_OPTIONS = 20;

/**
 * Read a write request's body. Shape only: every value is re-checked by the
 * write itself against the room (ids, lengths, options, the gate).
 */
export function parsePanelOp(body: unknown): PanelOp | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const id = isUuid(b.id) ? b.id : null;
  const text = (v: unknown) => (typeof v === "string" && v.length <= MAX_FIELD ? v : null);
  const flag = (v: unknown) => (typeof v === "boolean" ? v : null);
  switch (b.op) {
    case "chat.send":
    case "qa.ask": {
      const t = text(b.body);
      return id && t !== null ? { op: b.op, id, body: t } : null;
    }
    case "chat.delete":
    case "qa.approve":
      return id ? { op: b.op, id } : null;
    case "chat.moderate":
      return id && CHAT_MODERATIONS.includes(b.action as ChatModeration)
        ? { op: b.op, id, action: b.action as ChatModeration }
        : null;
    case "qa.vote":
    case "qa.spotlight": {
      const on = flag(b.on);
      return id && on !== null ? { op: b.op, id, on } : null;
    }
    case "qa.status":
      return id && (QUESTION_STATUSES as readonly unknown[]).includes(b.status)
        ? { op: b.op, id, status: b.status as QuestionState }
        : null;
    case "poll.create": {
      const question = text(b.question);
      const options =
        Array.isArray(b.options) && b.options.length <= MAX_OPTIONS
          ? b.options.map(text)
          : null;
      const resultsVisible = flag(b.resultsVisible);
      const open = flag(b.open);
      if (question === null || !options || options.some((o) => o === null)) return null;
      if (resultsVisible === null || open === null) return null;
      return { op: b.op, question, options: options as string[], resultsVisible, open };
    }
    case "poll.open": {
      const open = flag(b.open);
      return id && open !== null ? { op: b.op, id, open } : null;
    }
    case "poll.vote":
      return id && Number.isInteger(b.choice) && (b.choice as number) >= 0
        ? { op: b.op, id, choice: b.choice as number }
        : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Ids and timestamps
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * A row id minted by the client, so a retried send is idempotent: the second
 * insert hits the primary key and the server answers with the first.
 */
export function newRowId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/**
 * The later of two timestamps (null-safe). Compared as instants, then as
 * text, so equal milliseconds still order by the microseconds Postgres sends.
 */
export function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const d = Date.parse(a) - Date.parse(b);
  if (d !== 0) return d > 0 ? a : b;
  return a >= b ? a : b;
}

/** Where an incremental read starts: the cursor minus the overlap. */
export function readFrom(cursor: string): string {
  return new Date(Date.parse(cursor) - CHAT_CURSOR_OVERLAP_MS).toISOString();
}

function byTime(a: ChatMessage, b: ChatMessage): number {
  return (
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

// ---------------------------------------------------------------------------
// The base: what the server last said
// ---------------------------------------------------------------------------

export type PanelBase = {
  audienceMode: AudienceMode;
  messages: ChatMessage[];
  pinned: ChatMessage | null;
  cursor: string | null;
  questions: RoomQuestion[];
  polls: WebinarPoll[];
};

export function baseFrom(initial: WebinarPanelInitial): PanelBase {
  return applyRead(
    {
      audienceMode: initial.audienceMode,
      messages: [],
      pinned: null,
      cursor: null,
      questions: [],
      polls: [],
    },
    initial,
  );
}

/**
 * Fold one read into the base. Reads run one at a time, so each is newer than
 * the last.
 *
 * A full chat read is the truth: it REPLACES the feed, so a removal, approval
 * or pin lands (an own send it predates is still drawn from its override). An
 * incremental read only merges. The cursor never moves backwards, and a
 * removed row never survives either path.
 */
export function applyRead(base: PanelBase, read: PanelRead): PanelBase {
  const next: PanelBase = { ...base, audienceMode: read.audienceMode };
  if (read.chat) {
    const c = read.chat;
    const merged = c.full
      ? mergeById(c.messages, [])
      : mergeById(base.messages, c.messages);
    next.messages = merged.filter((m) => !m.removedAt).slice(-CHAT_KEEP);
    next.pinned = c.pinned && !c.pinned.removedAt ? c.pinned : null;
    next.cursor = laterIso(base.cursor, c.cursor);
  }
  if (read.questions) next.questions = read.questions;
  if (read.polls) next.polls = read.polls;
  return next;
}

/** Union by id (later list wins), oldest first. */
export function mergeById(
  a: readonly ChatMessage[],
  b: readonly ChatMessage[],
): ChatMessage[] {
  if (b.length === 0) return [...a].sort(byTime);
  const byId = new Map(a.map((m) => [m.id, m]));
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort(byTime);
}

// ---------------------------------------------------------------------------
// Optimistic overrides
// ---------------------------------------------------------------------------

export type Override<T> = {
  /** Client clock when the write settled; null while it is in flight. */
  settledAt: number | null;
  /** Edit the server's row; null hides it. */
  patch?: (row: T) => T | null;
  /** A row to show even before any read returns it (an own send). */
  insert?: T;
  /** Placed by a removal hint, which anyone holding the topic could send. */
  fromHint?: boolean;
};
export type Overrides<T> = ReadonlyMap<string, Override<T>>;

/**
 * Drop what a read has caught up with. A full read covers every override that
 * settled before it started; `onlyIds` narrows that to rows the read actually
 * returned (an incremental chat read says nothing about older rows).
 */
export function pruneOverrides<T>(
  overrides: Overrides<T>,
  readStartedAt: number,
  onlyIds?: ReadonlySet<string>,
): Map<string, Override<T>> {
  const next = new Map(overrides);
  for (const [id, o] of overrides) {
    if (o.settledAt === null || o.settledAt >= readStartedAt) continue;
    if (onlyIds && !onlyIds.has(id)) continue;
    next.delete(id);
  }
  return next;
}

/**
 * Removal hints a full read just contradicted: the hint hid a row the server
 * still returns (a real removal is written before its hint is sent). Those ids
 * stop being trusted, so replaying a forged hint blanks a message for one
 * read at most.
 */
export function contradictedHints<T>(
  overrides: Overrides<T>,
  readStartedAt: number,
  returnedIds: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const [id, o] of overrides) {
    if (o.fromHint && o.settledAt !== null && o.settledAt < readStartedAt && returnedIds.has(id)) {
      out.push(id);
    }
  }
  return out;
}

/** Server rows with patches applied, hidden rows dropped, inserts appended. */
export function withOverrides<T extends { id: string }>(
  rows: readonly T[],
  overrides: Overrides<T>,
): T[] {
  if (overrides.size === 0) return rows as T[];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.id);
    const o = overrides.get(row.id);
    const shown = o?.patch ? o.patch(row) : row;
    if (shown) out.push(shown);
  }
  for (const [id, o] of overrides) {
    if (!o.insert || seen.has(id)) continue;
    const shown = o.patch ? o.patch(o.insert) : o.insert;
    if (shown) out.push(shown);
  }
  return out;
}

/** The chat feed as drawn: base + overrides, oldest first. */
export function viewChat(
  base: Pick<PanelBase, "messages">,
  overrides: Overrides<ChatMessage>,
): ChatMessage[] {
  return withOverrides(base.messages, overrides)
    .filter((m) => !m.removedAt)
    .sort(byTime);
}

/** The pinned strip as drawn. An optimistic pin wins; an override can unpin or hide. */
export function viewPinned(
  base: Pick<PanelBase, "pinned">,
  feed: readonly ChatMessage[],
  overrides: Overrides<ChatMessage>,
): ChatMessage | null {
  const local = feed.find((m) => m.pinned && overrides.has(m.id));
  if (local) return local;
  const p = base.pinned;
  if (!p) return null;
  const o = overrides.get(p.id);
  const shown = o?.patch ? o.patch(p) : p;
  return shown && shown.pinned && !shown.removedAt ? shown : null;
}

/** Hide a row (a removal you made, or one a hint announced). */
export const hideRow = (): null => null;

/** Upvote / un-upvote, relative to whatever the server last said. */
export function voteOn(on: boolean) {
  return (q: RoomQuestion): RoomQuestion =>
    q.voted === on
      ? q
      : { ...q, voted: on, voteCount: Math.max(0, q.voteCount + (on ? 1 : -1)) };
}

/** Choose a poll option, moving the reader's vote in the tally. */
export function chooseOption(choice: number) {
  return (p: WebinarPoll): WebinarPoll => {
    if (p.myChoice === choice) return p;
    const tally = [...p.tally];
    if (p.myChoice !== null && tally[p.myChoice] > 0) tally[p.myChoice] -= 1;
    if (choice < tally.length) tally[choice] += 1;
    return { ...p, myChoice: choice, tally };
  };
}

// ---------------------------------------------------------------------------
// Realtime hints
// ---------------------------------------------------------------------------

export type RoomHint =
  | { kind: "react"; emoji: Reaction }
  | {
      kind: "bump";
      part: PanelPart;
      /** A new chat row at the end of the feed: an incremental read covers it. */
      cursor: string | null;
      /** A chat row was removed: drop it now, confirm with a full read. */
      removed: string | null;
    };

/**
 * Read one message off the room channel. Every participant holds the topic,
 * so this is untrusted input: anything malformed is ignored, and nothing in a
 * hint is ever drawn except a reaction from the fixed alphabet.
 */
export function parseRoomHint(payload: unknown): RoomHint | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.t === "react") {
    return isReaction(p.emoji) ? { kind: "react", emoji: p.emoji } : null;
  }
  if (p.t !== "bump") return null;
  const part: PanelPart | null =
    p.what === "chat" ? "chat" : p.what === "qa" ? "qa" : p.what === "poll" ? "poll" : null;
  if (!part) return null;
  return {
    kind: "bump",
    part,
    cursor: part === "chat" && isIsoTimestamp(p.cursor) ? p.cursor : null,
    removed: part === "chat" && isUuid(p.removed) ? p.removed : null,
  };
}

/** The hint a removal publishes: an id, never content. */
export function chatRemovedHint(messageId: string): Extract<RoomMessage, { t: "bump" }> {
  return { t: "bump", what: "chat", removed: messageId };
}

/** What a debounced burst of hints asks the next read for. */
export type ReadRequest = { parts: Set<PanelPart>; fullChat: boolean };

export function emptyReadRequest(): ReadRequest {
  return { parts: new Set(), fullChat: false };
}

export function fullReadRequest(): ReadRequest {
  return { parts: new Set(PANEL_PARTS), fullChat: true };
}

/** Fold a hint into the pending read. A chat bump without a cursor needs the full feed. */
export function requestFor(
  req: ReadRequest,
  hint: Extract<RoomHint, { kind: "bump" }>,
): ReadRequest {
  const parts = new Set(req.parts).add(hint.part);
  const fullChat =
    req.fullChat || (hint.part === "chat" && (!hint.cursor || !!hint.removed));
  return { parts, fullChat };
}

export function mergeReadRequests(a: ReadRequest, b: ReadRequest): ReadRequest {
  return {
    parts: new Set([...a.parts, ...b.parts]),
    fullChat: a.fullChat || b.fullChat,
  };
}

// ---------------------------------------------------------------------------
// Outbox and unread
// ---------------------------------------------------------------------------

/**
 * Automatic attempts before a send waits for the person to press Retry —
 * enough to ride out a rate-limit window (5 per 10s) on a fast typist.
 */
export const OUTBOX_MAX_ATTEMPTS = 8;

/** Backoff before attempt `attempt + 1`: 1s, 2s, 4s… capped at 8s, or the server's hint. */
export function retryDelayMs(attempt: number, hintMs?: number): number {
  if (hintMs && hintMs > 0) return Math.min(hintMs, 15_000);
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 8000);
}

/**
 * Rows not drawn before, by id. A removal (the newest row going away) or a
 * row a forged hint hid and a read restored is never an arrival.
 */
export function arrivals<T extends { id: string }>(
  rows: readonly T[],
  shown: ReadonlySet<string>,
): T[] {
  return rows.filter((r) => !shown.has(r.id));
}

/** Items from other people that the reader has not seen yet. */
export function unseenCount(
  items: readonly { id: string; mine: boolean }[],
  seen: ReadonlySet<string>,
): number {
  let n = 0;
  for (const i of items) if (!i.mine && !seen.has(i.id)) n += 1;
  return n;
}

/** Open polls the reader has not seen open yet. */
export function unseenOpenPolls(
  polls: readonly Pick<WebinarPoll, "id" | "open">[],
  seenOpen: ReadonlySet<string>,
): number {
  let n = 0;
  for (const p of polls) if (p.open && !seenOpen.has(p.id)) n += 1;
  return n;
}

/** Which tabs this reader gets. Chat only where the audience may see itself. */
export function panelTabs(role: PanelRole, chatOn: boolean): PanelTab[] {
  const tabs: PanelTab[] = chatOn ? ["chat", "qa", "polls"] : ["qa", "polls"];
  if (role !== "viewer") tabs.push("people");
  return tabs;
}
