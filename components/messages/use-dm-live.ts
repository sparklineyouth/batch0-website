"use client";
import { useEffect, useRef } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

/**
 * Live updates for direct messages.
 *
 * Two subscriptions, kept deliberately separate:
 *
 *   useThreadLive(conversationId)  postgres_changes on dm_messages, ALWAYS
 *                                  filtered to one conversation. Never
 *                                  unfiltered — see the Realtime note in
 *                                  migration 0089: an unfiltered subscription
 *                                  would be trusting Realtime to re-apply the
 *                                  read policy to every DM body in the system.
 *
 *   useInboxLive()                 postgres_changes on `notifications`,
 *                                  filtered to this user (the same per-user
 *                                  table the bell uses, 0016). This is how the
 *                                  unread badge and the conversation list
 *                                  learn about a message in a thread that
 *                                  isn't open.
 *
 * supabase-js is loaded on demand for the same reason the notification bell
 * does it: ~63 kB gz of auth/realtime code has no business in the first load
 * of every authed page just because a chat launcher sits in the corner.
 */

let supabasePromise: Promise<SupabaseClient> | null = null;
function getSupabase(): Promise<SupabaseClient> {
  if (!supabasePromise) {
    const p = import("@/lib/supabase/client").then((m) => m.createClient());
    // Don't memoize a failed chunk load (offline, deploy skew) — the safety
    // poll in the components should get to retry.
    p.catch(() => {
      if (supabasePromise === p) supabasePromise = null;
    });
    supabasePromise = p;
  }
  return supabasePromise;
}

let inFlightUserId: Promise<string | null> | null = null;
/**
 * The signed-in user's id, joining any call already in flight. Same reasoning
 * as the bell's: several of these mount at once and auth-js serializes
 * getUser() behind a shared lock, so without this they run end to end. Cleared
 * once settled rather than cached, so a sign-out in the same SPA session can't
 * hand the next user the previous one's id.
 */
function getUserId(supabase: SupabaseClient): Promise<string | null> {
  if (!inFlightUserId) {
    const p = supabase.auth
      .getUser()
      .then(({ data }) => data.user?.id ?? null)
      .catch(() => null)
      .finally(() => {
        if (inFlightUserId === p) inFlightUserId = null;
      });
    inFlightUserId = p;
  }
  return inFlightUserId;
}

/** Short unique-per-mount suffix for realtime channel topics. */
function uniqueSuffix(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}

export type LiveMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
};

/**
 * Subscribe to one conversation's new messages. `onMessage` is kept in a ref
 * so a re-render with a fresh closure doesn't tear the channel down and
 * rebuild it — only a change of conversation does that.
 */
export function useThreadLive(
  conversationId: string | null,
  onMessage: (m: LiveMessage) => void,
) {
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    let client: SupabaseClient | null = null;
    let channel: RealtimeChannel | null = null;

    (async () => {
      const supabase = await getSupabase().catch(() => null);
      if (cancelled || !supabase) return;
      client = supabase;
      // A per-mount suffix, not a stable name: the browser client is a
      // singleton, so `dm-<id>` gets REUSED across React Strict Mode's dev
      // double-mount and adding callbacks to an already-subscribed channel
      // throws.
      const ch = supabase
        .channel(`dm-${conversationId}-${uniqueSuffix()}`)
        .on(
          "postgres_changes" as any,
          {
            event: "INSERT",
            schema: "public",
            table: "dm_messages",
            filter: `conversation_id=eq.${conversationId}`,
          },
          (payload: any) => handler.current(payload.new as LiveMessage),
        )
        .on(
          "postgres_changes" as any,
          {
            event: "DELETE",
            schema: "public",
            table: "dm_messages",
            filter: `conversation_id=eq.${conversationId}`,
          },
          // A DELETE payload carries only the primary key (no replica
          // identity full), which is all an unsend needs.
          (payload: any) =>
            handler.current({
              id: (payload.old as any)?.id,
              conversation_id: conversationId,
              sender_id: "",
              body: "",
              created_at: "",
            }),
        )
        .subscribe();
      channel = ch;
      // Torn down while awaiting the client: cleanup already ran with
      // `channel` still null, so remove it here or leak a subscription.
      if (cancelled) {
        supabase.removeChannel(ch);
        channel = null;
      }
    })();

    return () => {
      cancelled = true;
      // removeChannel, not unsubscribe: it also evicts the channel from the
      // client registry, so a remount can't collide with it.
      if (client && channel) client.removeChannel(channel);
    };
  }, [conversationId]);
}

/**
 * Fire `onPing` whenever a direct-message notification lands for this user —
 * i.e. a conversation went from "caught up" to "has something new". That is
 * exactly the transition the unread-conversation badge counts.
 */
export function useInboxLive(onPing: () => void) {
  const handler = useRef(onPing);
  handler.current = onPing;

  useEffect(() => {
    let cancelled = false;
    let client: SupabaseClient | null = null;
    let channel: RealtimeChannel | null = null;

    (async () => {
      const supabase = await getSupabase().catch(() => null);
      if (cancelled || !supabase) return;
      client = supabase;
      const uid = await getUserId(supabase);
      if (cancelled || !uid) return;
      const ch = supabase
        .channel(`dm-inbox-${uid}-${uniqueSuffix()}`)
        .on(
          "postgres_changes" as any,
          {
            event: "INSERT",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${uid}`,
          },
          (payload: any) => {
            if ((payload.new as any)?.type === "direct_message") handler.current();
          },
        )
        .subscribe();
      channel = ch;
      if (cancelled) {
        supabase.removeChannel(ch);
        channel = null;
      }
    })();

    return () => {
      cancelled = true;
      if (client && channel) client.removeChannel(channel);
    };
  }, []);
}
