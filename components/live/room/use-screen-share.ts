"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { screenShareError } from "./logic";

type DisplayMedia = MediaDevices & {
  getDisplayMedia?: (c?: DisplayMediaStreamOptions & Record<string, unknown>) => Promise<MediaStream>;
};

/** Constraints: capped at 1080p/30, text-friendly, never the call's own tab. */
export const DISPLAY_MEDIA_OPTIONS = {
  video: {
    width: { max: 1920 },
    height: { max: 1080 },
    frameRate: { ideal: 15, max: 30 },
  },
  audio: false,
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include",
} as const;

/** getDisplayMedia exists (it doesn't on iOS/Android). Server render: false. */
export function useScreenShareSupported(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => typeof navigator !== "undefined" && !!(navigator.mediaDevices as DisplayMedia | undefined)?.getDisplayMedia,
    () => false,
  );
}
const noopSubscribe = () => () => {};

function platform(): "mac" | "windows" | "other" {
  if (typeof navigator === "undefined") return "other";
  const p = `${navigator.platform ?? ""} ${navigator.userAgent}`;
  if (/Mac/i.test(p)) return "mac";
  if (/Win/i.test(p)) return "windows";
  return "other";
}

/**
 * Screen sharing. The browser's own "Stop sharing" bar ends the track; that is
 * reflected here so every control follows. A generation counter drops a picker
 * that resolves after stop() or unmount (otherwise the capture would run on,
 * unseen, until the tab closed).
 */
export function useScreenShare() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const genRef = useRef(0);
  const pendingRef = useRef(false);
  const supported = useScreenShareSupported();

  const stop = useCallback(() => {
    genRef.current += 1;
    setStream((s) => {
      s?.getTracks().forEach((t) => t.stop());
      return null;
    });
  }, []);

  /** Must be called from the click handler itself (Safari needs the gesture). */
  const start = useCallback(async (): Promise<MediaStream | null> => {
    if (pendingRef.current) return null;
    const md = (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined) as
      | DisplayMedia
      | undefined;
    if (!md?.getDisplayMedia) {
      setError(screenShareError("NotSupportedError", ""));
      return null;
    }
    const gen = ++genRef.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const s = await md.getDisplayMedia(DISPLAY_MEDIA_OPTIONS as unknown as DisplayMediaStreamOptions);
      if (gen !== genRef.current) {
        s.getTracks().forEach((t) => t.stop());
        return null;
      }
      const track = s.getVideoTracks()[0];
      if (track) {
        try {
          track.contentHint = "detail";
        } catch {
          /* read-only in a few old engines */
        }
        track.addEventListener("ended", () => setStream((cur) => (cur === s ? null : cur)));
      }
      setStream((prev) => {
        prev?.getTracks().forEach((t) => t.stop());
        return s;
      });
      return s;
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (gen === genRef.current) setError(screenShareError(err?.name, err?.message, platform()));
      return null;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, []);

  // Unmount: stop the capture and orphan any open picker.
  const streamRef = useRef<MediaStream | null>(null);
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);
  useEffect(
    () => () => {
      genRef.current += 1;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const clearError = useCallback(() => setError(null), []);

  return { stream, start, stop, error, clearError, pending, supported };
}
