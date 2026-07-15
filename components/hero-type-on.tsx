"use client";
import { useLayoutEffect } from "react";

/**
 * THE SIGNATURE MECHANIC — on homepage load the hero sentence types
 * itself once: nine weeks / one company / yours. Under 1.2s total
 * (27 chars × 34ms + two 90ms beat pauses ≈ 1.1s), a block cursor rides
 * the active beat, then the resident cursor idles blinking at the end.
 * The facts line and button reveal after the sentence finishes; their
 * space is reserved (visibility, not display), so nothing shifts.
 *
 * Runs once per visit (sessionStorage), never loops. Server markup is
 * the complete static hero, so no-JS and prefers-reduced-motion visitors
 * see everything instantly — this component simply does nothing for them.
 * This is the hero's ONLY motion.
 */
export function HeroTypeOn() {
  useLayoutEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let typed = null;
    try {
      typed = sessionStorage.getItem("b0-hero-typed");
    } catch {
      return; // storage unavailable: skip the animation, stay static
    }
    if (typed) return;

    const beats = Array.from(
      document.querySelectorAll<HTMLElement>("[data-typeon]"),
    );
    const reveals = Array.from(
      document.querySelectorAll<HTMLElement>("[data-typeon-reveal]"),
    );
    const idleCursor = document.querySelector<HTMLElement>(
      "[data-typeon-cursor]",
    );
    if (!beats.length) return;
    // NOTE: the once-per-visit flag is set on COMPLETION, not here. Setting
    // it up front breaks under React StrictMode's dev double-mount: mount 1
    // flags + starts, the fake unmount restores the static text, mount 2
    // sees the flag and skips — net result, no animation at all.

    const texts = beats.map((b) => b.textContent ?? "");
    beats.forEach((b) => (b.textContent = " ")); // keep each line box
    reveals.forEach((r) => (r.style.visibility = "hidden"));
    if (idleCursor) idleCursor.style.display = "none";

    const mc = document.createElement("span");
    mc.className = "cursor-block";
    mc.setAttribute("aria-hidden", "true");

    const CHAR_MS = 34;
    const BEAT_MS = 90;
    let bi = 0;
    let ci = 0;
    const timers: number[] = [];
    const step = () => {
      const full = texts[bi];
      ci++;
      beats[bi].textContent = full.slice(0, ci) || " ";
      beats[bi].appendChild(mc);
      if (ci >= full.length) {
        bi++;
        ci = 0;
        if (bi >= beats.length) {
          mc.remove();
          if (idleCursor) idleCursor.style.display = "";
          reveals.forEach((r) => (r.style.visibility = ""));
          try {
            sessionStorage.setItem("b0-hero-typed", "1");
          } catch {}
          return;
        }
        timers.push(window.setTimeout(step, BEAT_MS));
      } else {
        timers.push(window.setTimeout(step, CHAR_MS));
      }
    };
    step();

    return () => {
      timers.forEach(clearTimeout);
      // if unmounted mid-type, restore the static state
      beats.forEach((b, i) => (b.textContent = texts[i]));
      reveals.forEach((r) => (r.style.visibility = ""));
      if (idleCursor) idleCursor.style.display = "";
      mc.remove();
    };
  }, []);
  return null;
}
