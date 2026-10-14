"use client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { SIGNAL_EVENT } from "@/lib/live-signal";

/**
 * One Realtime subscription per room / moderation topic, shared by the side
 * panel and the reactions button and overlay.
 *
 * realtime-js keeps one channel per topic per client: a second
 * `channel(topic)` returns the same object, so two components subscribing on
 * their own would double every handler, and one tearing down would cut the
 * other off. Teardown waits a beat, so a remount (or StrictMode's double
 * effect) re-uses the live channel instead of racing its removal.
 */

type Listener = (payload: unknown) => void;
type Hub = {
  channel: RealtimeChannel;
  listeners: Set<Listener>;
  teardown: ReturnType<typeof setTimeout> | null;
};

const hubs = new Map<string, Hub>();
const TEARDOWN_DELAY_MS = 1_000;

export function listenRoom(topic: string, listener: Listener): () => void {
  let hub = hubs.get(topic);
  if (!hub) {
    const channel = createClient().channel(topic);
    const fresh: Hub = { channel, listeners: new Set(), teardown: null };
    channel.on("broadcast", { event: SIGNAL_EVENT }, (m) => {
      for (const l of fresh.listeners) l(m.payload);
    });
    channel.subscribe();
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
      void createClient().removeChannel(h.channel);
    }, TEARDOWN_DELAY_MS);
  };
}

/**
 * Publish straight onto a topic this tab listens to, and echo it to the local
 * listeners — Realtime does not deliver a sender's own broadcast back to it.
 * Only reactions are published from the browser; everything else is a server
 * hint.
 */
export function publishRoom(topic: string, payload: unknown): void {
  const hub = hubs.get(topic);
  if (!hub) return;
  for (const l of hub.listeners) l(payload);
  void hub.channel
    .send({ type: "broadcast", event: SIGNAL_EVENT, payload })
    .catch(() => {
      // A dropped reaction is a clap nobody saw; nothing to retry.
    });
}
