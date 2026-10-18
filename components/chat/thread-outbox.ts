import { localOnly } from "./live-rows.ts";
import type { UiMessage } from "./types";

// ---------------------------------------------------------------------------
// Thread replies that haven't gone yet (migration 0110), kept outside the
// thread pane. The pane is a component that comes and goes: Back on a phone,
// opening another thread, or switching the side panel unmounts it or points
// it elsewhere, and the composer is already empty by then. A reply still
// sending, or one that failed, lives here, by its thread's root, so it's
// waiting with its Retry when that thread opens again — and the feed can say
// under the root that a reply didn't send. The channel feed does the same
// for its own bubbles (ChatApp's cache: unsent and failed ones ride along).
// One per ChatApp. Relative imports only, so `node --test` runs its test.
// ---------------------------------------------------------------------------

export type ThreadOutbox = {
  /** The unsent and failed replies kept for a thread, oldest first. */
  get: (rootId: string) => UiMessage[];
  /** What the pane now has for a thread: its unsent and failed replies are kept, anything sent is let go. */
  keep: (rootId: string, replies: readonly UiMessage[]) => void;
  /** Change a thread's kept replies from outside its pane: a send that finished after the pane moved on. */
  update: (rootId: string, fn: (list: UiMessage[]) => UiMessage[]) => void;
  /** Roots with a reply that failed to send. The same Set until that changes. */
  failedRoots: () => ReadonlySet<string>;
  /** Told when failedRoots() changes. */
  subscribe: (fn: () => void) => () => void;
};

export function createThreadOutbox(): ThreadOutbox {
  const kept = new Map<string, UiMessage[]>();
  const listeners = new Set<() => void>();
  let failed: ReadonlySet<string> = new Set();

  const settle = () => {
    const next = new Set<string>();
    for (const [root, list] of kept) if (list.some((m) => !!m.failed)) next.add(root);
    const same = next.size === failed.size && Array.from(next).every((r) => failed.has(r));
    if (same) return;
    failed = next;
    for (const fn of Array.from(listeners)) fn();
  };

  const put = (rootId: string, list: readonly UiMessage[]) => {
    const mine = list.filter(localOnly);
    if (mine.length) kept.set(rootId, mine);
    else kept.delete(rootId);
    settle();
  };

  return {
    get: (rootId) => [...(kept.get(rootId) ?? [])],
    keep: put,
    update: (rootId, fn) => put(rootId, fn([...(kept.get(rootId) ?? [])])),
    failedRoots: () => failed,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
