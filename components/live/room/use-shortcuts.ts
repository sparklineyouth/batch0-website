"use client";
import { useEffect, useRef } from "react";
import type { LocalMediaView } from "./types";

/** Meet's shortcuts: Ctrl/Cmd+D toggles the mic, Ctrl/Cmd+E the camera. */
export function useRoomShortcuts(media: LocalMediaView | null) {
  const ref = useRef(media);
  useEffect(() => {
    ref.current = media;
  }, [media]);
  const active = !!media;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.repeat) return;
      const key = e.key.toLowerCase();
      const m = ref.current;
      if (!m) return;
      if (key === "d") {
        e.preventDefault();
        m.toggleMic();
      } else if (key === "e") {
        e.preventDefault();
        m.toggleCamera();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}
