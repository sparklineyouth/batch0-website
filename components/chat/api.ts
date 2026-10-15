import type { MessagesByIdPayload, MessagesPayload } from "@/app/chat/api/reads";
import type { ChatPerson, SidebarData } from "./types";

/**
 * Chat's reads, over plain GET (app/chat/api/*), and the bookkeeping that
 * keeps the client's own URL writes out of Next's way.
 *
 * Next runs server actions one at a time, in one queue. A poll or a resync
 * made as a server action makes the send typed right after it wait its turn,
 * so the reads are route handlers that run alongside. Mutations stay server
 * actions. The routes answer `{ ok: true, data }` or `{ ok: false, error }`,
 * never a 500.
 */

export type MessagesPage = MessagesPayload;
export type MessagesById = MessagesByIdPayload;
export type PinsPage = MessagesByIdPayload;
export type Attention = { n: number; userId: string | null };

/** What a failed read says, whatever went wrong underneath. */
export const READ_FAILED = "Couldn't load that. Check your connection and try again.";
export const NOT_AVAILABLE = "That conversation isn't available. It may not exist, or you may not be in it.";

/**
 * A read that didn't work. `gone` means the server answered and said no
 * (no access, or no such channel), as opposed to a network blip or an
 * outage, which are worth retrying.
 */
export class ChatReadError extends Error {
  readonly gone: boolean;
  constructor(gone: boolean) {
    super(gone ? NOT_AVAILABLE : READ_FAILED);
    this.name = "ChatReadError";
    this.gone = gone;
  }
}

async function get<T>(path: string, params: Record<string, string | null | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const query = qs.toString();
  const url = `/chat/api/${path}${query ? `?${query}` : ""}`;
  let res: Response;
  try {
    // A signed-out request is redirected to the login page: don't fetch it.
    res = await fetch(url, { cache: "no-store", credentials: "same-origin", redirect: "manual", headers: { accept: "application/json" } });
  } catch {
    throw new ChatReadError(false);
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: unknown } | null;
  if (body && typeof body === "object" && "ok" in body) {
    if (body.ok === true) return body.data as T;
    // 404: the server's "not available". Anything else (signed out, a
    // failure underneath) may work on a retry.
    throw new ChatReadError(res.status === 403 || res.status === 404);
  }
  if (res.ok && body !== null) return body as T;
  throw new ChatReadError(res.status === 403 || res.status === 404);
}

export const chatApi = {
  sidebar: () => get<SidebarData>("sidebar"),
  /** The newest page, the page before (createdAt, id), or a window around one message. */
  messages: (channelId: string, opts: { before?: { createdAt: string; id: string }; around?: string } = {}) =>
    get<MessagesPage>("messages", {
      c: channelId,
      before: opts.before?.createdAt,
      beforeId: opts.before?.id,
      around: opts.around,
    }),
  messagesById: (channelId: string, ids: readonly string[]) =>
    get<MessagesById>("messages-by-id", { c: channelId, ids: ids.slice(0, 50).join(",") }),
  members: (channelId: string) => get<ChatPerson[]>("members", { c: channelId }),
  pins: (channelId: string) => get<PinsPage>("pins", { c: channelId }),
  attention: () => get<Attention>("attention"),
};

/**
 * Was this a server action's answer coming back as "no" (it threw on the
 * server: production strips the words, but leaves a digest), rather than a
 * network failure? Read actions throw for "not available".
 */
export function serverSaidNo(err: unknown): boolean {
  return !!err && typeof err === "object" && "digest" in err;
}

// ---------------------------------------------------------------------------
// The address bar. Next patches history.pushState/replaceState: each call
// becomes a router "restore", and a restore that lands while a server action
// is still in Next's queue throws that action's result away and re-renders
// the whole page on the server afterwards. So the chat writes its URL only
// once none of its own server actions is outstanding, and a beat after the
// last one settles (the queue lets go a few microtasks after the caller's
// promise resolves).
// ---------------------------------------------------------------------------

let inFlight = 0;
/** An action just settled: Next's queue lets go of it a few microtasks later. */
let settling = false;
let queued: { url: string; push: boolean } | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** The path the chat was mounted on, while it is (holdChatUrl); null once it's gone. */
let chatPath: string | null = null;

/**
 * The chat is on screen: its URL writes may go through. Call on mount, and
 * the returned function on unmount. A write that comes due after a link out
 * of chat (a channel answering late, a queued flush) is dropped: the address
 * bar belongs to the next page by then, and a /chat URL there would make
 * reload and Back land in chat.
 */
export function holdChatUrl(): () => void {
  chatPath = window.location.pathname;
  return () => {
    chatPath = null;
    queued = null;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  };
}

/** Count a server action as in flight until it settles. Returns it untouched. */
export function tracked<T>(p: Promise<T>): Promise<T> {
  inFlight++;
  const done = () => {
    inFlight--;
    settling = true;
    setTimeout(() => {
      settling = false;
    }, 0);
    if (inFlight === 0 && queued) scheduleFlush();
  };
  p.then(done, done);
  return p;
}

function write(url: string, push: boolean) {
  if (typeof window === "undefined" || !chatPath) return;
  // Still the chat's page (where it was mounted, or a /chat URL it wrote)?
  const path = window.location.pathname;
  if (path !== chatPath && path !== new URL(url, window.location.href).pathname) return;
  const here = path + window.location.search;
  if (push) window.history.pushState(null, "", url);
  else if (here !== url) window.history.replaceState(null, "", url);
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (inFlight > 0 || !queued) return;
    const { url, push } = queued;
    queued = null;
    write(url, push);
  }, 0);
}

/**
 * Put the chat's state in the address bar: replace the current entry, or
 * push a new one (a phone opening a conversation from the list, so Back
 * returns to the list). Written at once when Next's queue is idle, else
 * once it is; the latest call wins, and a push stays a push.
 */
export function writeChatUrl(url: string, opts: { push?: boolean } = {}) {
  const push = !!opts.push || (queued?.push ?? false);
  if (inFlight === 0 && !settling && !queued) {
    write(url, push);
    return;
  }
  queued = { url, push };
  if (inFlight === 0) scheduleFlush();
}

/** Drop a push still waiting to be written. True if there was one (so there's no entry to go Back from). */
export function dropQueuedPush(): boolean {
  if (!queued?.push) return false;
  queued = null;
  return true;
}
