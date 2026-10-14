"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { applySpeaker } from "@/components/live/audio-output";

type AudioCtor = typeof AudioContext;
function audioCtor(): AudioCtor | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext ??
    null
  );
}

/**
 * Three short tones through the chosen speaker. The tones are generated
 * (OscillatorNode → MediaStreamDestination) and played by an <audio> element,
 * because only media elements can be routed to a chosen output (setSinkId).
 * Resolves when the sound is done.
 */
export async function playTestSound(speakerId: string): Promise<void> {
  const Ctor = audioCtor();
  if (!Ctor) return;
  const ac = new Ctor();
  try {
    if (ac.state === "suspended") await ac.resume().catch(() => {});
    const dest = ac.createMediaStreamDestination();
    let t = ac.currentTime + 0.05;
    for (const f of [523.25, 659.25, 783.99]) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      osc.connect(gain);
      gain.connect(dest);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.start(t);
      osc.stop(t + 0.32);
      t += 0.34;
    }
    const el = new Audio();
    el.srcObject = dest.stream;
    await applySpeaker(el, speakerId);
    try {
      await el.play();
    } catch {
      // No media-element playback: fall back to the default output.
      ac.createMediaStreamSource(dest.stream).connect(ac.destination);
    }
    await new Promise((r) => setTimeout(r, Math.ceil((t - ac.currentTime) * 1000) + 150));
    el.pause();
    el.srcObject = null;
  } finally {
    void ac.close().catch(() => {});
  }
}

function recorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return undefined;
}

export const MIC_TEST_SECONDS = 3;

/** Record three seconds of the mic, then play it back through the chosen speaker. */
export function useMicTest(stream: MediaStream | null, speakerId: string) {
  const [state, setState] = useState<"idle" | "recording" | "playing">("idle");
  const [left, setLeft] = useState(0);
  const cleanup = useRef<(() => void) | null>(null);
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(typeof MediaRecorder !== "undefined"), []);

  const stop = useCallback(() => {
    cleanup.current?.();
    cleanup.current = null;
    setState("idle");
  }, []);

  useEffect(() => () => cleanup.current?.(), []);

  const start = useCallback(() => {
    const tracks = stream?.getAudioTracks() ?? [];
    if (!tracks.length || typeof MediaRecorder === "undefined") return;
    cleanup.current?.();
    const mime = recorderMime();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined);
    } catch {
      return;
    }
    const chunks: Blob[] = [];
    let cancelled = false;
    let url: string | null = null;
    const el = new Audio();
    const timers: ReturnType<typeof setTimeout>[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      if (cancelled) return;
      url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" }));
      el.src = url;
      el.onended = () => stop();
      setState("playing");
      void applySpeaker(el, speakerId).then(() => el.play().catch(() => stop()));
    };
    cleanup.current = () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      if (rec.state !== "inactive") rec.stop();
      el.pause();
      el.removeAttribute("src");
      if (url) URL.revokeObjectURL(url);
    };
    rec.start();
    setState("recording");
    setLeft(MIC_TEST_SECONDS);
    for (let i = 1; i < MIC_TEST_SECONDS; i++) {
      timers.push(setTimeout(() => setLeft(MIC_TEST_SECONDS - i), i * 1000));
    }
    timers.push(
      setTimeout(() => {
        if (rec.state !== "inactive") rec.stop();
      }, MIC_TEST_SECONDS * 1000),
    );
  }, [stream, speakerId, stop]);

  return { state, left, start, stop, supported };
}
