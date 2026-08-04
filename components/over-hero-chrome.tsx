"use client";
import React, { useEffect, useState } from "react";

/**
 * The homepage chrome stack, floated over the hero's night-city image.
 *
 * At rest the bars are transparent so the poster reads as one full-bleed
 * image. The moment the visitor starts scrolling — and well before the
 * hero lockup travels up under the nav — the stack takes the normal
 * opaque `paper` background and its hairline back, so nav text never has
 * to compete with the lit horizon in the middle of the image.
 *
 * The trigger is an IntersectionObserver on a sentinel that the hero
 * renders across its top 25vh: no scroll listener, no rAF, no layout
 * reads. If the sentinel is missing (any page that mounts this without a
 * hero) it fails safe to the opaque state.
 */
export function OverHeroChrome({ children }: { children: React.ReactNode }) {
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    const sentinel = document.getElementById("hero-sentinel");
    if (!sentinel) {
      setSolid(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => setSolid(!entry.isIntersecting),
      { threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);

  return (
    <div
      data-solid={solid || undefined}
      className={
        "fixed inset-x-0 top-0 z-50 transition-colors duration-150 " +
        "motion-reduce:transition-none " +
        "data-[solid]:border-b data-[solid]:border-line data-[solid]:bg-paper"
      }
    >
      {children}
    </div>
  );
}
