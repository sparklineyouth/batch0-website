"use client";
import { useEffect, useSyncExternalStore } from "react";
import { badgeText } from "@/lib/chat-access";
import { chatApi, type Attention } from "./api";
import { listenForPings, pingDelay } from "./use-chat-live";

/**
 * The count on the "Chat" nav link: DMs and groups with something unread,
 * plus channel mentions. Rides the chat bells (one per burst) for instant
 * updates, with a slow poll as the safety net. Renders nothing at zero.
 *
 * It reads a GET route (/chat/api/attention), not a server action: Next runs
 * server actions one at a time, so a badge refresh would make whatever the
 * person clicks next wait behind it. Whose bells to listen for comes back
 * with the count, so none of the layouts has to thread a user id down.
 *
 * Every mounted badge shares one store: the desktop sidebar's, and the phone
 * drawer's each time it opens. One fetch, one poll, one bell subscription,
 * and a count younger than MIN_GAP_MS is reused rather than refetched.
 */

const POLL_MS = 60_000;
const MIN_GAP_MS = 30_000;

let state: Attention = { n: 0, userId: null };
let fetchedAt = 0;
let inflight: Promise<void> | null = null;
let mounts = 0;
let poll: ReturnType<typeof setInterval> | null = null;
let pingTimer: ReturnType<typeof setTimeout> | null = null;
let ping: { userId: string; stop: () => void } | null = null;
const subscribers = new Set<() => void>();

function set(next: Attention) {
  if (next.n === state.n && next.userId === state.userId) return;
  state = next;
  for (const s of subscribers) s();
  syncPing();
}

function refresh(force = false) {
  if (inflight || (!force && Date.now() - fetchedAt < MIN_GAP_MS)) return;
  inflight = chatApi
    .attention()
    .then((r) => set({ n: Number(r?.n) || 0, userId: typeof r?.userId === "string" ? r.userId : null }))
    .catch(() => undefined)
    .finally(() => {
      fetchedAt = Date.now();
      inflight = null;
    });
}

function onVisible() {
  if (document.visibilityState === "visible") refresh();
}

/** One bell subscription, for whoever the count belongs to, while any badge is mounted. */
function syncPing() {
  const want = mounts > 0 ? state.userId : null;
  if (ping && ping.userId === want) return;
  ping?.stop();
  ping = null;
  if (!want) return;
  ping = {
    userId: want,
    stop: listenForPings(want, (type) => {
      if (pingTimer) return;
      pingTimer = setTimeout(() => {
        pingTimer = null;
        refresh(true);
      }, pingDelay(type));
    }),
  };
}

function mount() {
  mounts++;
  if (mounts === 1) {
    poll = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  refresh();
  syncPing();
}

function unmount() {
  mounts--;
  if (mounts > 0) return;
  if (poll) clearInterval(poll);
  poll = null;
  if (pingTimer) clearTimeout(pingTimer);
  pingTimer = null;
  document.removeEventListener("visibilitychange", onVisible);
  syncPing();
}

function subscribe(cb: () => void) {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function ChatNavBadge() {
  const n = useSyncExternalStore(
    subscribe,
    () => state.n,
    () => 0,
  );
  useEffect(() => {
    mount();
    return unmount;
  }, []);
  return n > 0 ? (
    <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-phosphor px-1.5 font-mono text-[10px] font-semibold text-on-phosphor">
      {badgeText(n)}
    </span>
  ) : null;
}
