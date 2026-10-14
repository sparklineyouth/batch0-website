"use client";
import { useEffect, useState } from "react";

/**
 * The live level (0–1, smoothed) of a stream's microphone, for a meter.
 *
 * Owns its own AudioContext and AnalyserNode and samples on a timer at `fps`
 * (default 12) rather than every animation frame, re-rendering only when the
 * value visibly moves. Mount it in the LEAF that draws the meter: whatever
 * calls it re-renders at that rate, and a room-level meter used to re-render
 * the whole room sixty times a second next to the video encoders.
 *
 * 0 while there is no live audio track. The context is closed on unmount and
 * whenever the stream changes, so no audio graph outlives the meter.
 */
export function useMicLevel(
  stream: MediaStream | null,
  opts?: { fps?: number },
): number {
  const fps = Math.max(1, Math.min(60, opts?.fps ?? 12));
  const [level, setLevel] = useState(0);
  const track =
    stream?.getAudioTracks().find((t) => t.readyState === "live") ?? null;

  useEffect(() => {
    if (!track) {
      setLevel(0);
      return;
    }
    const Ctx: typeof AudioContext | undefined =
      typeof window === "undefined"
        ? undefined
        : (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext);
    if (!Ctx) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctx();
    } catch {
      return; // no meter, nothing else lost
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let smoothed = 0;
      let shown = 0;
      // A context created without a user gesture starts suspended (Safari).
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      timer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        // Speech RMS sits well under 0.5; scale up so the meter moves.
        const scaled = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        smoothed = smoothed * 0.6 + scaled * 0.4;
        if (
          Math.abs(smoothed - shown) >= 0.02 ||
          (smoothed < 0.01 && shown !== 0)
        ) {
          shown = smoothed < 0.01 ? 0 : smoothed;
          setLevel(shown);
        }
      }, 1000 / fps);
    } catch {
      /* no meter */
    }
    return () => {
      if (timer) clearInterval(timer);
      void ctx.close().catch(() => {});
      setLevel(0);
    };
  }, [track, fps]);

  return level;
}
