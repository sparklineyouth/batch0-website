"use client";
import { useEffect, useRef } from "react";

/**
 * THE SKY — ambient pixel weather for the marketing poster zones (hero and
 * closing poster only). Same block language as the wordmark:
 *
 *   phosphor (night): sparse 1–2 block stars in faint ink, two amber-dim
 *   accents; slow stepped twinkle; a rare pixel METEOR streaks a zone.
 *   paper (day): small blocky clouds in warm white; a rare pixel BIRD
 *   crosses. Everything flat, stepped, aria-hidden, pointer-events-none.
 *
 * THE RETUNE (user-initiated theme switches only): the chrome hard-cuts;
 * the sky is weather and re-tunes instead. On switch the old sky vanishes
 * with the cut, the zones stay genuinely EMPTY for 3–4s, then the new sky
 * materializes staggered over ~1.8s — each element arriving via a CRT
 * misconvergence glitch: three block-copies in pure signal red/green/blue
 * jitter ±1–2 blocks around the target in choppy ~70ms steps for ~450ms,
 * then snap into one element in its true flat palette color. Signal RGB
 * exists ONLY inside that sub-second convergence — never at rest.
 *
 * Rules enforced here: never on first load or system-pref resolution (the
 * retune only runs on the ThemeToggle's "b0-theme-switch" event); rapid
 * toggles cancel any pending/in-flight retune and restart the clock; the
 * delay clock pauses while the tab is hidden; prefers-reduced-motion gets
 * an instant static swap (no delay, no RGB, no twinkle/meteors/birds);
 * ambient timers start only after the retune finishes.
 */

type El = {
  x: number; // % of zone width
  y: number; // % of zone height
  rows: string[]; // pixel bitmap, "#" = block
  color: string; // flat palette color at rest
  px: number; // block size in px
};

const STAR1 = ["#"];
const STAR2 = [".#.", "###", ".#."];
const CLOUD_A = ["..####..", "########"];
const CLOUD_B = [".###.", "#####"];
const RGB = ["#ff0000", "#00ff00", "#0000ff"];

// deterministic PRNG — SSR-safe, stable per zone
function prng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) & 0x7fffffff) / 2147483647;
}

function buildSet(theme: "phosphor" | "paper", zone: string): El[] {
  const r = prng(zone === "hero" ? 41 : 97);
  const els: El[] = [];
  if (theme === "phosphor") {
    for (let i = 0; i < 16; i++) {
      const bright = i % 7 === 0;
      els.push({
        x: 3 + r() * 94,
        y: 4 + r() * 88,
        rows: bright ? STAR2 : STAR1,
        // two amber-dim accents; the rest faint ink
        color: i % 9 === 0 ? "rgb(var(--phosphor-rgb) / 0.5)" : "rgb(var(--ink) / 0.38)",
        px: bright ? 3 : 3,
      });
    }
  } else {
    for (let i = 0; i < 4; i++) {
      els.push({
        x: 6 + r() * 80,
        y: 6 + r() * 60,
        rows: i % 2 ? CLOUD_B : CLOUD_A,
        color: "rgb(255 255 255 / 0.85)",
        px: 6,
      });
    }
  }
  return els;
}

function renderEl(el: El, host: HTMLElement): HTMLElement {
  const d = document.createElement("div");
  d.style.cssText = `position:absolute;left:${el.x}%;top:${el.y}%;display:grid;grid-template-columns:repeat(${el.rows[0].length},${el.px}px);grid-auto-rows:${el.px}px;`;
  el.rows.forEach((row, ri) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== "#") continue;
      const b = document.createElement("span");
      b.style.cssText = `grid-column:${c + 1};grid-row:${ri + 1};background:${el.color};`;
      d.appendChild(b);
    }
  });
  host.appendChild(d);
  return d;
}

export function Sky({ zone }: { zone: "hero" | "close" }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const theme = () =>
      document.documentElement.classList.contains("paper")
        ? ("paper" as const)
        : ("phosphor" as const);

    let timers: ReturnType<typeof setTimeout>[] = [];
    let ambient: ReturnType<typeof setTimeout>[] = [];
    let live: HTMLElement[] = [];
    let retuneAt = 0; // epoch ms the pending retune should fire; 0 = none
    let pendingT: ReturnType<typeof setTimeout> | undefined;
    const clearAll = (arr: ReturnType<typeof setTimeout>[]) =>
      arr.splice(0).forEach(clearTimeout);

    const wipe = () => {
      clearAll(timers);
      clearAll(ambient);
      live.splice(0).forEach((e) => e.remove());
    };

    /* ---- ambient life: stepped twinkle + rare meteor/bird ---- */
    const startAmbient = () => {
      if (reduced) return;
      clearAll(ambient);
      const twinkle = () => {
        ambient.push(
          setTimeout(() => {
            const e = live[Math.floor(Math.random() * live.length)];
            if (e && theme() === "phosphor") {
              e.style.opacity = "0.25";
              ambient.push(setTimeout(() => (e.style.opacity = ""), 160));
            }
            twinkle();
          }, 2200 + Math.random() * 2600),
        );
      };
      const streak = () => {
        ambient.push(
          setTimeout(() => {
            if (!document.hidden) {
              // meteor (night) / bird (day): 4 blocks crossing in 8 steps
              const night = theme() === "phosphor";
              const s = renderEl(
                {
                  x: 10 + Math.random() * 55,
                  y: 8 + Math.random() * 30,
                  rows: night ? ["##", ".##"] : [".##.", "#..#"],
                  color: night
                    ? "rgb(var(--ink) / 0.7)"
                    : "rgb(var(--ink) / 0.5)",
                  px: night ? 3 : 4,
                },
                host,
              );
              let f = 0;
              const step = () => {
                f++;
                s.style.transform = `translate(${f * (night ? 14 : 10)}px, ${f * (night ? 10 : 2)}px)`;
                s.style.opacity = f > 5 ? "0.3" : "1";
                if (f < 8) ambient.push(setTimeout(step, 70));
                else s.remove();
              };
              step();
            }
            streak();
          }, 20000 + Math.random() * 20000),
        );
      };
      twinkle();
      streak();
    };

    /* ---- materialize: instant (initial/reduced) or via misconvergence -- */
    const appear = (instant: boolean) => {
      const set = buildSet(theme(), zone);
      if (instant) {
        live = set.map((el) => renderEl(el, host));
        startAmbient();
        return;
      }
      const order = set.map((_, i) => i).sort(() => 0.5 - Math.random());
      let done = 0;
      order.forEach((idx, k) => {
        timers.push(
          setTimeout(() => {
            const el = set[idx];
            // three signal-RGB block copies jitter and converge, stepped
            const copies = RGB.map((c) => renderEl({ ...el, color: c }, host));
            let f = 0;
            const FRAMES = 6; // ~450ms at 75ms
            const conv = () => {
              f++;
              const amp = Math.max(0, (FRAMES - f) * 0.7); // blocks of jitter
              copies.forEach((cp, ci) => {
                const dx = Math.round((Math.random() * 2 - 1) * amp * el.px);
                const dy = Math.round((Math.random() * 2 - 1) * amp * el.px);
                cp.style.transform = `translate(${dx + (ci - 1) * amp * 2}px, ${dy}px)`;
              });
              if (f < FRAMES) {
                timers.push(setTimeout(conv, 75));
              } else {
                // final frame: copies snap into one true-color element
                copies.forEach((cp) => cp.remove());
                live.push(renderEl(el, host));
                if (++done === set.length) startAmbient();
              }
            };
            conv();
          }, Math.round((k / order.length) * 1800)),
        );
      });
    };

    /* ---- the retune clock (pausable while hidden) ---- */
    const armRetune = () => {
      wipe(); // hard cut removes the old sky, zones go genuinely empty
      if (reduced) {
        appear(true);
        return;
      }
      retuneAt = Date.now() + 3500 + Math.random() * 500;
      schedule();
    };
    const schedule = () => {
      if (pendingT) clearTimeout(pendingT);
      if (!retuneAt) return;
      if (document.hidden) return; // resumes on visibilitychange
      pendingT = setTimeout(() => {
        retuneAt = 0;
        appear(false);
      }, Math.max(0, retuneAt - Date.now()));
    };
    const onVis = () => {
      if (document.hidden && pendingT) {
        // pause: freeze remaining time by pushing the deadline out
        clearTimeout(pendingT);
        retuneAt = Date.now() + Math.max(0, retuneAt - Date.now());
      } else if (!document.hidden) {
        schedule();
      }
    };
    const onSwitch = () => armRetune(); // user-initiated only (toggle event)

    appear(true); // first load / system-pref: instant, no retune
    addEventListener("b0-theme-switch", onSwitch);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      removeEventListener("b0-theme-switch", onSwitch);
      document.removeEventListener("visibilitychange", onVis);
      if (pendingT) clearTimeout(pendingT);
      wipe();
    };
  }, [zone]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 select-none overflow-hidden"
    />
  );
}
