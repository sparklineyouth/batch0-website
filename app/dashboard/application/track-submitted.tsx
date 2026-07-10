"use client";
import { useEffect, useRef } from "react";
import { track } from "@vercel/analytics";

/**
 * Fires the application_submitted analytics event exactly once when the
 * apply form's success redirect lands here with ?submitted=1. Tracking on
 * the redirect target (not the submit click) means the event only counts
 * real, persisted submissions.
 */
export function TrackSubmitted() {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    track("application_submitted");
    // Drop the flag from the URL so a refresh doesn't re-fire.
    const url = new URL(window.location.href);
    url.searchParams.delete("submitted");
    window.history.replaceState(null, "", url.pathname + url.search);
  }, []);
  return null;
}
