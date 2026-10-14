"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Between re-checks while waiting. */
const EVERY_MS = 30_000;
/** Spread so a room full of waiting people doesn't re-check in the same second. */
const JITTER_MS = 3_000;

/**
 * On a "this opens at…" page: ask the server again every 30 s while the tab
 * is visible, once more just after `opensAt`, and whenever the tab comes back
 * — so someone waiting is let in without reloading, including when a host
 * goes live early. The server decides; this only re-renders the page.
 */
export function RefreshUntilOpen({ opensAt }: { opensAt: string }) {
  const router = useRouter();
  useEffect(() => {
    const at = Date.parse(opensAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const untilOpen = Number.isFinite(at) ? at - Date.now() : Infinity;
      const wait = untilOpen > 0 ? Math.min(EVERY_MS, untilOpen + 1_000) : EVERY_MS;
      timer = setTimeout(tick, wait + Math.random() * JITTER_MS);
    };
    const tick = () => {
      if (!document.hidden) router.refresh();
      schedule();
    };
    const onVisible = () => {
      if (!document.hidden) router.refresh();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [opensAt, router]);
  return null;
}
