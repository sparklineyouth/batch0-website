import type { LiveRow } from "./use-chat-live";

/**
 * How the open thread's pane hears what Realtime delivers (migration 0110).
 * ChatApp owns the one subscription to the open channel's messages; a row
 * that is a thread reply, or an update to one, is handed to whoever listens
 * here instead of the feed, and a reconnect asks them to resync. One bus per
 * ChatApp, a handful of listeners at most.
 */
export type ThreadEvent = { kind: "insert"; row: LiveRow } | { kind: "update"; row: LiveRow } | { kind: "resync" };

export type ThreadBus = {
  emit: (e: ThreadEvent) => void;
  subscribe: (fn: (e: ThreadEvent) => void) => () => void;
};

export function createThreadBus(): ThreadBus {
  const listeners = new Set<(e: ThreadEvent) => void>();
  return {
    emit: (e) => {
      for (const fn of Array.from(listeners)) fn(e);
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
