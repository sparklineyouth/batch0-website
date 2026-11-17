"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

/**
 * Live chat over Supabase Realtime. Three kinds of subscription:
 *
 *   useMessageFeed(channelId)    postgres_changes on chat_messages for the
 *                                OPEN channel only (channel_id=eq.<id>).
 *                                Realtime re-applies the 0101 read policy to
 *                                every row. Every other channel's unread count
 *                                comes from the sidebar poll and the bell
 *                                ping: a subscription per sidebar channel
 *                                multiplied Realtime's traffic by every tab.
 *   usePresence(userId)          who's online: one presence key per account.
 *   useTyping(channelId)         "is typing…" broadcasts for the open channel.
 *
 * Plus usePing: a new chat bell (someone started a DM with you, mentioned you
 * in a channel you've never opened) — the signal to refresh the sidebar.
 *
 * Presence ('chat-presence') and typing ('chat-typing:<channel>') are
 * PRIVATE topics: Realtime checks 0101's realtime.messages policies before
 * letting anyone join, read or send (signed-in, let-in people for presence;
 * the channel's readers for its typing topic). They carry a user id and
 * nothing else, never a word of a message. If a join is refused, presence
 * and typing just stay empty: chat works without them.
 *
 * supabase-js is loaded on demand, so its ~60 kB stays out of the first load.
 */

let supabasePromise: Promise<SupabaseClient> | null = null;
function getSupabase(): Promise<SupabaseClient> {
  if (!supabasePromise) {
    const p = import("@/lib/supabase/client").then((m) => m.createClient());
    p.catch(() => {
      if (supabasePromise === p) supabasePromise = null;
    });
    supabasePromise = p;
  }
  return supabasePromise;
}

function suffix(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

/**
 * A raw chat_messages row, as Realtime delivers it. On an UPDATE a column can
 * be missing altogether: Postgres leaves an unchanged out-of-line (TOASTed)
 * value out of the change record, so a reaction on a long message arrives
 * without `body`. Treat a missing column as "unchanged".
 */
export type LiveRow = {
  id: string;
  channel_id: string;
  sender_id: string | null;
  body?: string;
  kind: "message" | "system";
  reply_to_id: string | null;
  mentions?: string[] | null;
  mention_everyone?: boolean;
  attachments?: unknown;
  reactions?: Record<string, string[]> | null;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  pinned_at?: string | null;
  /**
   * The sender's composer id for it (0104): how the sending tab knows its own
   * echo. Missing before 0104 runs (the column isn't there, or isn't granted).
   */
  client_id?: string | null;
  /**
   * A thread reply's root (0110): the reply belongs to that thread, not the
   * feed. Missing before 0110 runs.
   */
  thread_root_id?: string | null;
  /**
   * When the thread on this message last changed in a way its readers see:
   * its question, its accepted answer, its help request (0112). A hint to
   * read the thread again, never the change itself. Missing before 0112.
   */
  thread_changed_at?: string | null;
};

/**
 * Subscribe to inserts and updates in the open channel. `onConnected` fires
 * on every (re)join — Realtime has no replay, so that's when to resync. An
 * update comes with its transaction's commit time, as Realtime reports it
 * (the database's clock), when it has one.
 */
export function useMessageFeed(
  channelId: string | null,
  handlers: {
    onInsert: (row: LiveRow) => void;
    onUpdate: (row: LiveRow, committedAt: string | null) => void;
    onConnected?: () => void;
  },
) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    let client: SupabaseClient | null = null;
    let ch: RealtimeChannel | null = null;

    (async () => {
      const supabase = await getSupabase().catch(() => null);
      if (cancelled || !supabase) return;
      client = supabase;
      const filter = `channel_id=eq.${channelId}`;
      ch = supabase
        .channel(`chat-feed-${suffix()}`)
        .on("postgres_changes" as any, { event: "INSERT", schema: "public", table: "chat_messages", filter }, (p: any) =>
          ref.current.onInsert(p.new as LiveRow),
        )
        .on("postgres_changes" as any, { event: "UPDATE", schema: "public", table: "chat_messages", filter }, (p: any) =>
          ref.current.onUpdate(p.new as LiveRow, typeof p.commit_timestamp === "string" ? p.commit_timestamp : null),
        )
        .subscribe((status: string) => {
          if (status === "SUBSCRIBED" && !cancelled) ref.current.onConnected?.();
        });
      if (cancelled) {
        supabase.removeChannel(ch);
        ch = null;
      }
    })();

    return () => {
      cancelled = true;
      if (client && ch) client.removeChannel(ch);
    };
  }, [channelId]);
}

/**
 * Call `onPing` with the bell's type whenever a chat bell lands for this
 * user. Returns the unsubscribe. (The nav badge shares one of these across
 * every place it's mounted; the chat page uses usePing.)
 */
export function listenForPings(userId: string, onPing: (type: string) => void): () => void {
  let cancelled = false;
  let client: SupabaseClient | null = null;
  let ch: RealtimeChannel | null = null;
  (async () => {
    const supabase = await getSupabase().catch(() => null);
    if (cancelled || !supabase) return;
    client = supabase;
    ch = supabase
      .channel(`chat-ping-${userId}-${suffix()}`)
      .on(
        "postgres_changes" as any,
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        (p: any) => {
          const type = (p.new as { type?: string })?.type ?? "";
          if (type.startsWith("chat_")) onPing(type);
        },
      )
      .subscribe();
    if (cancelled) {
      supabase.removeChannel(ch);
      ch = null;
    }
  })();
  return () => {
    cancelled = true;
    if (client && ch) client.removeChannel(ch);
  };
}

/** Fire when a chat bell lands for this user, with the bell's type. */
export function usePing(userId: string, onPing: (type: string) => void) {
  const ref = useRef(onPing);
  ref.current = onPing;
  useEffect(() => listenForPings(userId, (type) => ref.current(type)), [userId]);
}

/**
 * How long to wait before refetching on a bell. One @everyone lands a bell
 * on every online account in the same second; spreading the refetches keeps
 * them from arriving at the database all at once. A DM's bell has one
 * recipient, so it barely waits.
 */
export function pingDelay(type: string): number {
  return type === "chat_dm" ? 250 + Math.random() * 1_250 : 1_000 + Math.random() * 7_000;
}

// ---------------------------------------------------------------------------
// Shared topics. realtime-js keeps ONE channel per topic per client — a
// second channel(topic) returns the first, even one still leaving — and
// removing one is async. So a quick A→B→A switch (or React StrictMode's
// double mount) could hand the new subscriber a channel that's being torn
// down, and it would never deliver. Like the live rooms'
// components/live/room/panel/room-channel.ts: one hub per topic, listeners
// counted, teardown a beat after the last one leaves so a remount reuses it,
// and a fresh join waits for a leave still in progress to finish.
// ---------------------------------------------------------------------------

type Listener = (payload: any) => void;
type Hub = {
  channel: RealtimeChannel;
  listeners: Set<Listener>;
  teardown: ReturnType<typeof setTimeout> | null;
};
const hubs = new Map<string, Hub>();
const leaving = new Map<string, Promise<unknown>>();
/** Topics Realtime wouldn't let this session join: don't keep knocking. */
const refused = new Set<string>();
const TEARDOWN_MS = 1_000;
/** realtime-js retries a failed join with a backoff; give up after this many. */
const JOIN_TRIES = 3;

function dropHub(supabase: SupabaseClient, topic: string, hub: Hub) {
  if (hubs.get(topic) === hub) hubs.delete(topic);
  const p: Promise<unknown> = supabase
    .removeChannel(hub.channel)
    .catch(() => undefined)
    .finally(() => {
      if (leaving.get(topic) === p) leaving.delete(topic);
    });
  leaving.set(topic, p);
}

async function joinHub(
  topic: string,
  setup: (ch: RealtimeChannel, emit: (payload: any) => void) => { onSubscribed?: () => void } | void,
  listener: Listener,
): Promise<() => void> {
  if (refused.has(topic)) return () => undefined;
  const supabase = await getSupabase();
  let hub = hubs.get(topic);
  if (!hub) {
    const gone = leaving.get(topic);
    if (gone) await gone;
    hub = hubs.get(topic);
  }
  if (!hub) {
    const channel = supabase.channel(topic, { config: { private: true, broadcast: { self: false } } });
    const fresh: Hub = { channel, listeners: new Set(), teardown: null };
    const hooks =
      setup(channel, (payload) => {
        for (const l of fresh.listeners) l(payload);
      }) ?? {};
    let joined = false;
    let failures = 0;
    channel.subscribe((status: string) => {
      if (status === "SUBSCRIBED") {
        joined = true;
        hooks.onSubscribed?.();
        return;
      }
      if (joined || (status !== "CHANNEL_ERROR" && status !== "TIMED_OUT")) return;
      // Never got in: most likely refused. Stop here; the feature stays empty.
      if (++failures >= JOIN_TRIES) {
        refused.add(topic);
        if (fresh.teardown) clearTimeout(fresh.teardown);
        dropHub(supabase, topic, fresh);
      }
    });
    hubs.set(topic, fresh);
    hub = fresh;
  }
  const h = hub;
  if (h.teardown) {
    clearTimeout(h.teardown);
    h.teardown = null;
  }
  h.listeners.add(listener);
  return () => {
    h.listeners.delete(listener);
    if (h.listeners.size > 0 || h.teardown || hubs.get(topic) !== h) return;
    h.teardown = setTimeout(() => {
      h.teardown = null;
      if (h.listeners.size > 0) return;
      dropHub(supabase, topic, h);
    }, TEARDOWN_MS);
  };
}

/** The set of user ids online in chat right now. */
export function usePresence(userId: string): Set<string> {
  const [online, setOnline] = useState<Set<string>>(() => new Set([userId]));
  useEffect(() => {
    let cancelled = false;
    let leave: (() => void) | null = null;
    joinHub(
      "chat-presence",
      (ch, emit) => {
        const sync = () => emit(Object.keys(ch.presenceState()));
        ch.on("presence", { event: "sync" }, sync).on("presence", { event: "join" }, sync).on("presence", { event: "leave" }, sync);
        // One key per account, so two tabs count once. Re-tracked on every
        // (re)join: the server forgets a connection's presence when it drops.
        return { onSubscribed: () => void ch.track({ user: userId }).catch(() => undefined) };
      },
      (ids: string[]) => {
        if (cancelled) return;
        const next = new Set([userId, ...presenceUsers(ids)]);
        // Presence events fire for the whole site: only re-render on a real change.
        setOnline((prev) => (prev.size === next.size && Array.from(next).every((id) => prev.has(id)) ? prev : next));
      },
    )
      .then((fn) => {
        if (cancelled) fn();
        else leave = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      leave?.();
    };
  }, [userId]);
  return online;
}

/** Presence keys are per connection; the tracked payload carries the account. */
function presenceUsers(keys: string[]): string[] {
  const out: string[] = [];
  for (const hub of hubs.values()) {
    if (hub.channel.topic !== "realtime:chat-presence") continue;
    const state = hub.channel.presenceState() as Record<string, { user?: string }[]>;
    for (const k of keys) for (const meta of state[k] ?? []) if (typeof meta.user === "string") out.push(meta.user);
  }
  return out;
}

const TYPING_TTL_MS = 7_000;
const TYPING_SEND_EVERY_MS = 4_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Typing state for one channel: who else is typing, a `notify()` to call on
 * every keystroke (throttled here, per channel), and `stop()` for when a
 * message sends. Switching channels tells the old one you stopped.
 *
 * Realtime only lets the channel's readers onto its typing topic, but a
 * broadcast's payload is whatever the sender wrote: `accept` drops an id that
 * can't be typing here (not a member of this DM or group, not an id at all).
 */
export function useTyping(channelId: string | null, userId: string, accept: (id: string) => boolean = () => true) {
  const [typing, setTyping] = useState<string[]>([]);
  const seen = useRef(new Map<string, number>());
  const lastSent = useRef(0);
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const topic = channelId ? `chat-typing:${channelId}` : null;

  useEffect(() => {
    setTyping([]);
    seen.current.clear();
    lastSent.current = 0;
    if (!topic) return;
    let cancelled = false;
    let leave: (() => void) | null = null;
    const prune = () => {
      const now = Date.now();
      for (const [id, at] of seen.current) if (now - at > TYPING_TTL_MS) seen.current.delete(id);
      setTyping((prev) => {
        const next = Array.from(seen.current.keys());
        return prev.length === next.length && prev.every((x, i) => x === next[i]) ? prev : next;
      });
    };
    const timer = setInterval(prune, 1_000);
    joinHub(
      topic,
      (ch, emit) => {
        ch.on("broadcast", { event: "typing" }, (m: any) => emit(m?.payload));
      },
      (payload: any) => {
        const who = payload?.userId;
        if (cancelled || typeof who !== "string" || who === userId || !UUID_RE.test(who) || !acceptRef.current(who)) return;
        if (payload?.stop) seen.current.delete(who);
        else seen.current.set(who, Date.now());
        prune();
      },
    )
      .then((fn) => {
        if (cancelled) fn();
        else leave = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      clearInterval(timer);
      // Typed here, then left: say so, or the others see "typing…" for a while.
      if (lastSent.current) broadcast(topic, { userId, stop: true });
      lastSent.current = 0;
      leave?.();
    };
  }, [topic, userId]);

  // Stable per channel, so the callbacks built on them don't change (and
  // re-render every message) on each keystroke.
  const notify = useCallback(() => {
    const now = Date.now();
    if (!topic || now - lastSent.current < TYPING_SEND_EVERY_MS) return;
    lastSent.current = now;
    broadcast(topic, { userId });
  }, [topic, userId]);
  const stop = useCallback(() => {
    if (!topic || !lastSent.current) return;
    lastSent.current = 0;
    broadcast(topic, { userId, stop: true });
  }, [topic, userId]);
  return { typing, notify, stop };
}

function broadcast(topic: string, payload: Record<string, unknown>) {
  const hub = hubs.get(topic);
  void hub?.channel.send({ type: "broadcast", event: "typing", payload }).catch(() => undefined);
}
