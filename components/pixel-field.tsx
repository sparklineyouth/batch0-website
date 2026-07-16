"use client";
import { useEffect } from "react";

/**
 * The marketing pages' interaction layer, in one client component:
 *
 *  - cursor-proximity field on every pixel-glyph block (`.px-cell`):
 *    blocks within ~70px displace up to 4px away and flip amber↔off-white
 *    inside ~40px, settling back on leave
 *  - rare ambient glitches, ONE element every 20–40s: a [data-retype]
 *    value re-types its tail, or one glyph block drops 8px and repairs
 *
 * HARD RULES (do not loosen):
 *  - prefers-reduced-motion: reduce → this component does NOTHING
 *  - transform + background paint only; a single rAF loop; block rects are
 *    cached and re-read only on resize / scroll-end
 *  - the scheduler pauses while the tab is hidden
 *  - NEVER mount this on /apply, checkout, or any form surface —
 *    transactional pages stay completely still
 */
export function PixelField() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const AMBER = "#FFBB00";
    const INK = "#f5f5f4";
    const blocks = Array.from(
      document.querySelectorAll<HTMLElement>(".px-cell"),
    );
    if (!blocks.length) return;

    /* ---- proximity field ---- */
    type Spot = { b: HTMLElement; x: number; y: number; base: string };
    let rects: Spot[] = [];
    const cacheRects = () => {
      rects = blocks.map((b) => {
        const r = b.getBoundingClientRect();
        return {
          b,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          base: b.dataset.base === "ink" ? INK : AMBER,
        };
      });
    };
    cacheRects();

    let mx = -1e4,
      my = -1e4,
      raf = 0;
    const R = 70,
      LIT = 40;
    const field = () => {
      raf = 0;
      for (const p of rects) {
        const dx = p.x - mx,
          dy = p.y - my;
        // blocks with a smolder shade (the hero 0) fall back to it, not to
        // the class color — the dither must survive the cursor passing
        if (Math.abs(dx) > R || Math.abs(dy) > R) {
          if (p.b.style.transform) {
            p.b.style.transform = "";
            p.b.style.background = p.b.dataset.shade ?? "";
          }
          continue;
        }
        const d = Math.hypot(dx, dy);
        if (d < R) {
          const f = ((R - d) / R) * 4;
          const n = d || 1;
          p.b.style.transform = `translate(${((dx / n) * f).toFixed(1)}px,${((dy / n) * f).toFixed(1)}px)`;
          p.b.style.background =
            d < LIT
              ? p.base === AMBER
                ? INK
                : AMBER
              : p.b.dataset.shade ?? "";
        }
      }
    };
    const onMove = (e: MouseEvent) => {
      mx = e.clientX;
      my = e.clientY;
      if (!raf) raf = requestAnimationFrame(field);
    };
    const onResize = () => requestAnimationFrame(cacheRects);
    let scrollT: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(scrollT);
      scrollT = setTimeout(cacheRects, 120);
    };
    addEventListener("mousemove", onMove, { passive: true });
    addEventListener("resize", onResize);
    addEventListener("scroll", onScroll, { passive: true });

    /* ---- rare ambient glitches ---- */
    const retypeEls = Array.from(
      document.querySelectorAll<HTMLElement>("[data-retype]"),
    );
    const timers: ReturnType<typeof setTimeout>[] = [];
    const gRetype = () => {
      if (!retypeEls.length) return;
      const el = retypeEls[Math.floor(Math.random() * retypeEls.length)];
      const full = el.textContent ?? "";
      let t = Math.max(0, full.length - 3);
      el.textContent = full.slice(0, t);
      const step = () => {
        el.textContent = full.slice(0, ++t);
        if (t < full.length) timers.push(setTimeout(step, 45));
      };
      step();
    };
    const gPixelDrop = () => {
      const b = blocks[Math.floor(Math.random() * blocks.length)];
      b.style.transition = "transform 90ms steps(2)";
      b.style.transform = "translateY(8px)";
      timers.push(
        setTimeout(() => {
          b.style.transform = "";
          timers.push(setTimeout(() => (b.style.transition = ""), 120));
        }, 140),
      );
    };
    const glitches = [gRetype, gPixelDrop];
    let schedT: ReturnType<typeof setTimeout>;
    const schedule = () => {
      schedT = setTimeout(
        () => {
          if (!document.hidden)
            glitches[Math.floor(Math.random() * glitches.length)]();
          schedule();
        },
        20000 + Math.random() * 20000,
      );
    };
    schedule();

    return () => {
      removeEventListener("mousemove", onMove);
      removeEventListener("resize", onResize);
      removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(schedT);
      clearTimeout(scrollT);
      timers.forEach(clearTimeout);
    };
  }, []);

  return null;
}
