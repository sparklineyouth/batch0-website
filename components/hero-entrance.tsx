"use client";
import { useEffect, useLayoutEffect } from "react";
import { SMOLDER_RAMP } from "@/components/smolder";

/**
 * THE SIGNATURE SEQUENCE — the hero assembles once per visit, total
 * ~1.65s, then is done forever:
 *
 *   1. black screen with only the status bar: the pixel-0's blocks snap
 *      in over ~0.7s, scatter-to-grid (translate + opacity only)
 *   2. the sentence reveals around the locked 0 (~0.6s): "one c" and
 *      "mpany" complete the word outward, "nine weeks" above, "yours."
 *      below; the resident cursor lands after it and idles
 *   3. identifier, facts, button, and the nav fade up (~0.3s)
 *
 * Zero layout shift at any point: every character is a pre-rendered span
 * toggled with visibility, the 0's grid box never changes size, and the
 * nav/reveal blocks keep their space. Once per visit: the flag is set on
 * COMPLETION (set-on-start self-cancels under StrictMode's dev double
 * mount). prefers-reduced-motion or no-JS: this component does nothing —
 * the server markup IS the settled hero. This is the hero's only motion;
 * after settling, the pixel-0 stays cursor-reactive via PixelField.
 */
export function HeroEntrance() {
  /* THE SMOLDER — the hero 0 slowly swaps block shades along the amber
   * ramp (each block moves to a NEIGHBORING shade roughly every 2–4s,
   * staggered; flat color to flat color, background only). Runs on every
   * visit (unlike the one-time entrance), starts after the entrance has
   * settled, and does nothing under reduced motion — those visitors keep
   * the static server-rendered ramp. The current shade also lives in
   * data-shade so PixelField's proximity flip can restore it. */
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const blocks = Array.from(
      document.querySelectorAll<HTMLElement>("[data-hz]"),
    );
    if (!blocks.length) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let iv: ReturnType<typeof setInterval> | undefined;
    const startT = setTimeout(() => {
      iv = setInterval(() => {
        // swap ~1/10th of the blocks per tick → each block shifts every ~3s
        const n = Math.max(1, Math.floor(blocks.length / 10));
        for (let k = 0; k < n; k++) {
          const b = blocks[Math.floor(Math.random() * blocks.length)];
          let si = parseInt(b.dataset.si ?? "2", 10);
          si = Math.max(0, Math.min(4, si + (Math.random() < 0.5 ? -1 : 1)));
          b.dataset.si = String(si);
          b.dataset.shade = SMOLDER_RAMP[si];
          b.style.transition = "background-color 600ms linear";
          b.style.background = SMOLDER_RAMP[si];
          // drop the transition after the swap so PixelField's proximity
          // flips stay instant, never mushy
          timers.push(setTimeout(() => (b.style.transition = ""), 650));
        }
      }, 300);
    }, 2000); // let the assembly finish first
    return () => {
      clearTimeout(startT);
      if (iv) clearInterval(iv);
      timers.forEach(clearTimeout);
      blocks.forEach((b) => (b.style.transition = ""));
    };
  }, []);

  useLayoutEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    try {
      if (sessionStorage.getItem("b0-hero-assembled")) return;
    } catch {
      return;
    }

    const $ = <T extends HTMLElement>(sel: string) =>
      Array.from(document.querySelectorAll<T>(sel));
    const blocks = $<HTMLElement>("[data-hz]");
    const chars = {
      top: $<HTMLElement>('[data-frag="top"] [data-ch]'),
      l: $<HTMLElement>('[data-frag="l"] [data-ch]'),
      r: $<HTMLElement>('[data-frag="r"] [data-ch]'),
      bottom: $<HTMLElement>('[data-frag="bottom"] [data-ch]'),
    };
    const reveals = $<HTMLElement>("[data-entrance-reveal]");
    const cursor = document.querySelector<HTMLElement>("[data-typeon-cursor]");
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Site"]');
    if (!blocks.length) return;

    const timers: number[] = [];
    const t = (fn: () => void, ms: number) =>
      timers.push(window.setTimeout(fn, ms));

    /* ---- hide everything the entrance owns (space stays reserved) ---- */
    const allChars = [...chars.top, ...chars.l, ...chars.r, ...chars.bottom];
    allChars.forEach((c) => (c.style.visibility = "hidden"));
    reveals.forEach((r) => {
      r.style.visibility = "hidden";
      r.style.opacity = "0";
      r.style.transform = "translateY(6px)";
    });
    if (cursor) cursor.style.display = "none";
    if (nav) nav.style.visibility = "hidden";

    /* ---- phase 1: scatter-to-grid (0 → ~700ms) ---- */
    // deterministic scatter (no Math.random cost per frame; varied by index)
    blocks.forEach((b, i) => {
      const dx = ((i * 53) % 69) - 34;
      const dy = ((i * 31) % 61) - 30;
      b.style.opacity = "0";
      b.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    const order = blocks.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = (i * 7919) % (i + 1); // deterministic shuffle
      [order[i], order[j]] = [order[j], order[i]];
    }
    const span = 550; // last block starts snapping by 550ms, lands ~700ms
    order.forEach((bi, k) => {
      t(() => {
        const b = blocks[bi];
        b.style.transition = "transform 150ms steps(2), opacity 60ms steps(1)";
        b.style.transform = "";
        b.style.opacity = "1";
      }, Math.round((k / order.length) * span));
    });
    t(() => blocks.forEach((b) => (b.style.transition = "")), 900);

    /* ---- phase 2: the sentence reveals around the 0 (~700 → 1300ms) ---- */
    const reveal = (els: HTMLElement[], start: number, step: number) =>
      els.forEach((el, i) => t(() => (el.style.visibility = ""), start + i * step));
    reveal([...chars.l].reverse(), 700, 30); // outward from the 0
    reveal(chars.r, 700, 30);
    reveal(chars.top, 750, 30);
    reveal(chars.bottom, 1050, 35);
    t(() => {
      if (cursor) cursor.style.display = "";
    }, 1290);

    /* ---- phase 3: identifier, facts, button, nav fade up (~1.3 → 1.6s) -- */
    t(() => {
      if (nav) nav.style.visibility = "";
      reveals.forEach((r) => {
        r.style.visibility = "";
        r.style.transition = "opacity 300ms ease-out, transform 300ms ease-out";
        r.style.opacity = "1";
        r.style.transform = "";
      });
    }, 1320);
    t(() => {
      reveals.forEach((r) => (r.style.transition = ""));
      try {
        sessionStorage.setItem("b0-hero-assembled", "1");
      } catch {}
    }, 1680);

    return () => {
      // restore the settled state if unmounted mid-flight (StrictMode-safe:
      // the remount simply restarts the sequence from scratch)
      timers.forEach(clearTimeout);
      allChars.forEach((c) => (c.style.visibility = ""));
      blocks.forEach((b) => {
        b.style.transition = "";
        b.style.transform = "";
        b.style.opacity = "";
      });
      reveals.forEach((r) => {
        r.style.transition = "";
        r.style.visibility = "";
        r.style.opacity = "";
        r.style.transform = "";
      });
      if (cursor) cursor.style.display = "";
      if (nav) nav.style.visibility = "";
    };
  }, []);
  return null;
}
