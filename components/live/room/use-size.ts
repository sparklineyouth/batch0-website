"use client";
import { useLayoutEffect, useState, type RefObject } from "react";

/** An element's content box size, kept current with a ResizeObserver. */
export function useSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setSize((s) =>
        Math.round(s.w) === Math.round(r.width) && Math.round(s.h) === Math.round(r.height)
          ? s
          : { w: r.width, h: r.height },
      );
    };
    read();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Whether a media query matches, kept current. False until mounted. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useLayoutEffect(() => {
    const mq = typeof window !== "undefined" ? window.matchMedia?.(query) : undefined;
    if (!mq) return;
    const read = () => setMatches(mq.matches);
    read();
    mq.addEventListener?.("change", read);
    return () => mq.removeEventListener?.("change", read);
  }, [query]);
  return matches;
}

/** Desktop: the side panel starts open. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * The side panel is a column beside the stage here, a bottom sheet elsewhere
 * (portrait phones). A phone on its side is too short for a sheet: it would
 * leave a sliver of the stage and a line or two of chat.
 */
export const PANEL_COLUMN_QUERY = "(min-width: 1024px), (min-width: 640px) and (orientation: landscape)";
