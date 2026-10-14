"use client";
import { useCallback, useSyncExternalStore } from "react";
import { levelFromRms, nextSpeaking, type SpeakingState } from "./logic";

/**
 * Audio levels for the room: the speaking ring on tiles and the mic meters.
 *
 * One shared AudioContext, one AnalyserNode per stream, one timer at 10 Hz for
 * all of them. Components subscribe per stream through `useSpeaking` /
 * `useAudioLevel`, so a level change re-renders only the leaf that shows it —
 * never the room. A stream's analyser exists while anything is subscribed.
 *
 * Remote WebRTC audio only reaches Web Audio in Chrome while it is also playing
 * in a media element; AudioSinks keeps one <audio> per remote, so it is.
 */

const TICK_MS = 100;

type Entry = {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  level: number;
  speaking: SpeakingState;
  listeners: Set<() => void>;
  trackIds: string;
};

let ctx: AudioContext | null = null;
const entries = new Map<MediaStream, Entry>();
let timer: ReturnType<typeof setInterval> | null = null;
let unlockArmed = false;

function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  armUnlock();
  return ctx;
}

/** A context created before any click starts suspended; resume on the next gesture. */
function armUnlock() {
  if (unlockArmed || typeof document === "undefined") return;
  unlockArmed = true;
  const resume = () => {
    void resumeAudio();
    if (ctx?.state === "running") {
      document.removeEventListener("pointerdown", resume, true);
      document.removeEventListener("keydown", resume, true);
      unlockArmed = false;
    }
  };
  document.addEventListener("pointerdown", resume, true);
  document.addEventListener("keydown", resume, true);
}

/** Resume the shared context (call from a click). */
export async function resumeAudio(): Promise<void> {
  if (ctx && ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* stays suspended until the next gesture */
    }
  }
}

function trackKey(stream: MediaStream): string {
  return stream
    .getAudioTracks()
    .map((t) => t.id)
    .join(",");
}

function build(stream: MediaStream): Entry | null {
  const ac = audioContext();
  if (!ac || stream.getAudioTracks().length === 0) return null;
  try {
    const source = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    return {
      source,
      analyser,
      buf: new Float32Array(analyser.fftSize),
      level: 0,
      speaking: { speaking: false, lastLoudAt: 0 },
      listeners: new Set(),
      trackIds: trackKey(stream),
    };
  } catch {
    return null;
  }
}

function tick() {
  const now = Date.now();
  for (const [stream, e] of entries) {
    // A stream whose audio track was swapped needs a fresh source node.
    const key = trackKey(stream);
    if (key !== e.trackIds) {
      e.source.disconnect();
      const fresh = build(stream);
      if (!fresh) continue;
      fresh.listeners = e.listeners;
      entries.set(stream, fresh);
      continue;
    }
    const live = stream.getAudioTracks().some((t) => t.enabled && t.readyState === "live");
    let rms = 0;
    if (live) {
      e.analyser.getFloatTimeDomainData(e.buf);
      let sum = 0;
      for (let i = 0; i < e.buf.length; i++) sum += e.buf[i] * e.buf[i];
      rms = Math.sqrt(sum / e.buf.length);
    }
    const level = Math.round(levelFromRms(rms) * 20) / 20;
    const speaking = nextSpeaking(e.speaking, rms, now);
    const changed = level !== e.level || speaking.speaking !== e.speaking.speaking;
    e.level = level;
    e.speaking = speaking;
    if (changed) for (const l of e.listeners) l();
  }
}

function subscribe(stream: MediaStream, listener: () => void): () => void {
  let e = entries.get(stream);
  if (!e) {
    const built = build(stream);
    if (!built) return () => {};
    e = built;
    entries.set(stream, e);
  }
  e.listeners.add(listener);
  if (!timer) timer = setInterval(tick, TICK_MS);
  return () => {
    const cur = entries.get(stream);
    if (!cur) return;
    cur.listeners.delete(listener);
    if (cur.listeners.size === 0) {
      cur.source.disconnect();
      entries.delete(stream);
    }
    if (entries.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function useEntryValue<T>(
  stream: MediaStream | null | undefined,
  read: (e: Entry) => T,
  fallback: T,
): T {
  const sub = useCallback(
    (l: () => void) => (stream ? subscribe(stream, l) : () => {}),
    [stream],
  );
  const get = () => {
    const e = stream ? entries.get(stream) : undefined;
    return e ? read(e) : fallback;
  };
  return useSyncExternalStore(sub, get, () => fallback);
}

/** Is this stream's voice active? Hysteresis included; updates at most 10×/s. */
export function useSpeaking(stream: MediaStream | null | undefined): boolean {
  return useEntryValue(stream, (e) => e.speaking.speaking, false);
}

/** 0..1 meter level, in steps of 0.05, at most 10×/s. */
export function useAudioLevel(stream: MediaStream | null | undefined): number {
  return useEntryValue(stream, (e) => e.level, 0);
}
