"use client";
import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

/**
 * Live chat over Supabase Realtime. Three kinds of subscription:
 *
 *   useMessageFeed(channelIds)   postgres_changes on chat_messages, ALWAYS
 *                                filtered with channel_id=in.(...) to
 *                                channels the server already cleared this
 *                                viewer for — never unfiltered. Realtime
 *                                re-applies the 0101 read policy to every row
 *                                on top. Chunked at Realtime's 100-value cap.
 *   usePresence(userId)          who's online: one presence key per account.
 *   useTyping(channelId)         "is typing…" broadcasts for the open channel.
 *
 * Plus usePing: a new chat bell (someone started a DM with you, mentioned you
 * in a channel you've never opened) — the signal to refresh the sidebar,
 * since a brand-new conversation isn't in the feed's filter yet.
 *
 * Presence and typing ride public broadcast topics, like the live rooms do:
 * they carry a user id and nothing else, never a word of a message.
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

/** A raw chat_messages row, as Realtime delivers it. */
export type LiveRow = {
  id: string;
  channel_id: string;
  sender_id: string | null;
  body: string;
  kind: "message" | "system";
  reply_to_id: string | null;
  mentions: string[] | null;
  mention_everyone: boolean;
  attachments: unknown;
  reactions: Record<string, string[]> | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  pinned_at: string | null;
};

const IN_FILTER_MAX = 100;

/**
 * Subscribe to inserts and updates in these channels. `onConnected` fires on
 * every (re)join — Realtime has no replay, so that's when to resync.
 */
export function useMessageFeed(
  channelIds: readonly string[],
  handlers: {
    onInsert: (row: LiveRow) => void;
    onUpdate: (row: LiveRow) => void;
    onConnected?: () => void;
  },
) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const key = Array.from(new Set(channelIds)).sort().join(",");

  useEffect(() => {
    if (!key) return;
    const ids = key.split(",");
    let cancelled = false;
    let client: SupabaseClient | null = null;
    const subs: RealtimeChannel[] = [];

    (async () => {
      const supabase = await getSupabase().catch(() => null);
      if (cancelled || !supabase) return;
      client = supabase;
      for (let i = 0; i < ids.length; i += IN_FILTER_MAX) {
        const part = ids.slice(i, i + IN_FILTER_MAX);
        const filter = `channel_id=in.(${part.join(",")})`;
        const ch = supabase
          .channel(`chat-feed-${i}-${suffix()}`)
          .on("postgres_changes" as any, { event: "INSERT", schema: "public", table: "chat_messages", filter }, (p: any) =>
            ref.current.onInsert(p.new as LiveRow),
          )
          .on("postgres_changes" as any, { event: "UPDATE", schema: "public", table: "chat_messages", filter }, (p: any) =>
            ref.current.onUpdate(p.new as LiveRow),
          )
          .subscribe((status: string) => {
            if (status === "SUBSCRIBED" && !cancelled) ref.current.onConnected?.();
          });
        subs.push(ch);
      }
      if (cancelled) for (const ch of subs) supabase.removeChannel(ch);
    })();

    return () => {
      cancelled = true;
      if (client) for (const ch of subs) client.removeChannel(ch);
    };
  }, [key]);
}

/** Fire when a chat bell lands for this user. */
export function usePing(userId: string, onPing: () => void) {
  const ref = useRef(onPing);
  ref.current = onPing;
  useEffect(() => {
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
            if (type.startsWith("chat_")) ref.current();
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
  }, [userId]);
}

// ---------------------------------------------------------------------------
// Shared topics. realtime-js keeps ONE channel per topic per client — a
// second channel(topic) returns the first — and removing one is async. So a
// quick A→B→A switch (or React StrictMode's double mount) would hand the new
// subscriber a channel that's still being torn down. Like the live rooms'
// components/live/room/panel/room-channel.ts: one hub per topic, listeners
// counted, teardown a beat after the last one leaves so a remount reuses it.
// ---------------------------------------------------------------------------

type Listener = (payload: any) => void;
type Hub = {
  channel: RealtimeChannel;
  listeners: Set<Listener>;
  teardown: ReturnType<typeof setTimeout> | null;
};
const hubs = new Map<string, Hub>();
const TEARDOWN_MS = 1_000;

async function joinHub(
  topic: string,
  setup: (ch: RealtimeChannel, emit: (payload: any) => void) => void,
  listener: Listener,
): Promise<() => void> {
  const supabase = await getSupabase();
  let hub = hubs.get(topic);
  if (!hub) {
    const channel = supabase.channel(topic, { config: { broadcast: { self: false } } });
    const fresh: Hub = { channel, listeners: new Set(), teardown: null };
    setup(channel, (payload) => {
      for (const l of fresh.listeners) l(payload);
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
    if (h.listeners.size > 0 || h.teardown) return;
    h.teardown = setTimeout(() => {
      h.teardown = null;
      if (h.listeners.size > 0) return;
      hubs.delete(topic);
      void supabase.removeChannel(h.channel);
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
        ch.on("presence", { event: "sync" }, sync)
          .on("presence", { event: "join" }, sync)
          .on("presence", { event: "leave" }, sync)
          .subscribe(async (status: string) => {
            // One key per account, so two tabs count once.
            if (status === "SUBSCRIBED") await ch.track({ user: userId }).catch(() => undefined);
          });
      },
      (ids: string[]) => {
        if (!cancelled) setOnline(new Set([userId, ...presenceUsers(ids)]));
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

const TYPING_TTL_MS = 6_000;
const TYPING_SEND_EVERY_MS = 2_500;

/**
 * Typing state for one channel: who else is typing, a `notify()` to call on
 * every keystroke (throttled here), and `stop()` for when a message sends.
 */
export function useTyping(channelId: string | null, userId: string) {
  const [typing, setTyping] = useState<string[]>([]);
  const seen = useRef(new Map<string, number>());
  const lastSent = useRef(0);
  const topic = channelId ? `chat-typing:${channelId}` : null;

  useEffect(() => {
    setTyping([]);
    seen.current.clear();
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
        ch.on("broadcast", { event: "typing" }, (m: any) => emit(m?.payload)).subscribe();
      },
      (payload: any) => {
        const who = payload?.userId;
        if (cancelled || typeof who !== "string" || who === userId) return;
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
      leave?.();
    };
  }, [topic, userId]);

  const send = (payload: Record<string, unknown>) => {
    const hub = topic ? hubs.get(topic) : undefined;
    void hub?.channel.send({ type: "broadcast", event: "typing", payload }).catch(() => undefined);
  };
  const notify = () => {
    const now = Date.now();
    if (now - lastSent.current < TYPING_SEND_EVERY_MS) return;
    lastSent.current = now;
    send({ userId });
  };
  const stop = () => {
    lastSent.current = 0;
    send({ userId, stop: true });
  };
  return { typing, notify, stop };
}
