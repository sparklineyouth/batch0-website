"use client";
import { useSyncExternalStore } from "react";

/**
 * Which speaker (audio output) remote voices play through.
 *
 * A tiny module-level store rather than a prop, because the thing that sets
 * it (the device picker, in the control bar or the green room) and the things
 * that obey it (every remote `<audio>` sink, several components deep in
 * broadcast-room) share no parent worth threading it through. It is also the
 * browser's choice, not the room's: remembered in localStorage, so the
 * headset picked in the green room is still the headset after joining, and
 * on the next call.
 *
 * "" means the system default. Choosing only works where the browser has
 * `HTMLMediaElement.setSinkId` (Chrome, Edge, Firefox; recent Safari) — the
 * picker hides the row elsewhere rather than offering a control that does
 * nothing.
 */

const KEY = "batch0.live.speaker";
let current: string | null = null;
const listeners = new Set<() => void>();

function read(): string {
  if (current === null) {
    try {
      current = window.localStorage.getItem(KEY) ?? "";
    } catch {
      // Private mode, blocked storage: the default device, every time.
      current = "";
    }
  }
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSpeakerId(deviceId: string): void {
  current = deviceId === "default" ? "" : deviceId;
  try {
    if (current) window.localStorage.setItem(KEY, current);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* remembered for this tab only */
  }
  for (const l of listeners) l();
}

/** The chosen speaker ("" for the system default). Server render: always "". */
export function useSpeakerId(): string {
  return useSyncExternalStore(subscribe, read, () => "");
}

/** Can this browser route audio to a chosen device at all? */
export function canPickSpeaker(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    "setSinkId" in HTMLMediaElement.prototype
  );
}

/**
 * Point one media element at the chosen speaker. Best-effort: a device that
 * has been unplugged since it was chosen rejects, and the element simply stays
 * on whatever it was playing through — never silent because of a stale pick.
 */
export async function applySpeaker(
  el: HTMLMediaElement,
  deviceId: string,
): Promise<void> {
  const sink = el as HTMLMediaElement & {
    sinkId?: string;
    setSinkId?: (id: string) => Promise<void>;
  };
  if (typeof sink.setSinkId !== "function") return;
  if ((sink.sinkId ?? "") === deviceId) return;
  try {
    await sink.setSinkId(deviceId);
  } catch {
    /* stays on the current output */
  }
}
