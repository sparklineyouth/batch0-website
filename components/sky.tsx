"use client";
import { useEffect, useRef } from "react";

/**
 * THE SKY — ambient pixel weather for the marketing poster zones (hero and
 * closing poster only), refined:
 *
 * DISTRIBUTION: density-gradient seeding — dense at the top of each zone,
 * thinning toward the bottom, with the last few elements tapering PAST the
 * zone boundary (~150px into the next section) at low presence: weather
 * fades at the horizon, no hard line. Poisson-ish rejection sampling with
 * a min-distance (no clumps, no grid), seeded per PAGE LOAD (deterministic
 * within a visit, different between visits). A center exclusion box keeps
 * stars out of the text/CTA area.
 *
 * STARS (phosphor): three sprites for depth — 1-block dust (most), 5-block
 * diamonds (some), 9-block four-pointed heroes with single-block ray tips
 * (rare, brightest, amber). GLIMMER: each star runs its own randomized
 * 4–8s cycle, stepped dim→mid→bright→hold→dim frames (~90ms), bright frame
 * at full presence — the sky visibly shimmers in any 5s glance.
 *
 * CLOUDS (paper): ink-tinted fill (~10% ink over paper) with a 1-block
 * darker bottom edge so the mass reads as a cloud, not a smudge.
 *
 * BIRDS (paper): enter one edge, cross the whole sky in ~25–40s with a
 * 2-frame flap and gentle height drift; ~1 in 3 crossings is a loose group
 * of 2–3. METEORS (phosphor): stepped streaks. ALL event timing rerolls
 * uniform-random each cycle (meteors 30–90s, birds 25–80s, first events
 * arrive sooner so they're discoverable) — nothing loops.
 *
 * THE RETUNE (unchanged contract): user-initiated theme switches only —
 * hard cut empties the sky, 3.5–4s of genuine emptiness, then the new set
 * materializes staggered, each element converging from three signal-RGB
 * PIXEL-BLOCK copies in choppy 75ms steps. RGB exists only inside that
 * sub-second window. Rapid toggles cancel + restart; the clock pauses
 * while hidden; prefers-reduced-motion gets instant static swaps and no
 * ambient motion at all.
 */

type El = {
  x: number;
  y: number; // % of zone height; may exceed 100 (the taper)
  rows: string[];
  base: string; // '#' fill at rest
  edge?: string; // 'e' cells (cloud bottom edge)
  px: number;
  presence: number; // resting opacity
  kind: "dust" | "mid" | "hero" | "cloud";
};

const SPRITES = {
  dust: ["#"],
  mid: [".#.", "###", ".#."],
  hero: ["..#..", "..#..", "#####", "..#..", "..#.."],
  cloudA: ["..####..", "########", "eeeeeeee"],
  cloudB: [".###.", "#####", "eeeee"],
};
const RGB = ["#ff0000", "#00ff00", "#0000ff"];
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

function prng(seed: number) {
  let s = seed % 2147483647 || 7;
  return () => ((s = (s * 16807) % 2147483647) & 0x7fffffff) / 2147483647;
}

/** density-gradient, min-distance, exclusion-box seeding */
function buildSet(theme: "phosphor" | "paper", seed: number): El[] {
  const r = prng(seed);
  const els: El[] = [];
  const place = (count: number, minDist: number, taper: number) => {
    const pts: { x: number; y: number }[] = [];
    let guard = 0;
    while (pts.length < count && guard++ < count * 30) {
      const x = 2 + r() * 96;
      const y = Math.pow(r(), 2.1) * taper; // top-dense, tapering down + past
      // text/CTA exclusion box (centered lockup)
      if (x > 22 && x < 78 && y > 26 && y < 88) continue;
      if (pts.some((p) => Math.abs(p.x - x) < minDist && Math.abs(p.y - y) < minDist * 2))
        continue;
      pts.push({ x, y });
    }
    return pts;
  };

  if (theme === "phosphor") {
    // 26 per zone: ~18 dust, ~6 mid, ~2 heroes; taper reaches ~118% of zone
    const pts = place(26, 5, 118);
    pts.forEach((p, i) => {
      const kind = i % 13 === 0 ? "hero" : i % 4 === 0 ? "mid" : "dust";
      const past = p.y > 100; // horizon taper: barely-there
      els.push({
        x: p.x,
        y: p.y,
        rows: SPRITES[kind === "hero" ? "hero" : kind === "mid" ? "mid" : "dust"],
        base:
          kind === "hero"
            ? "rgb(var(--phosphor-rgb))"
            : "rgb(var(--ink))",
        px: 3,
        presence: past ? 0.12 : kind === "hero" ? 0.55 : kind === "mid" ? 0.42 : 0.34,
        kind,
      });
    });
  } else {
    const pts = place(6, 16, 112);
    pts.forEach((p, i) => {
      els.push({
        x: Math.min(p.x, 80),
        y: p.y * 0.7,
        rows: i % 2 ? SPRITES.cloudB : SPRITES.cloudA,
        base: "rgb(var(--ink) / 0.10)",
        edge: "rgb(var(--ink) / 0.22)",
        px: 6,
        presence: p.y > 100 ? 0.4 : 1,
        kind: "cloud",
      });
    });
  }
  return els;
}

function renderEl(el: El, host: HTMLElement, color?: string): HTMLElement {
  const d = document.createElement("div");
  d.style.cssText = `position:absolute;left:${el.x}%;top:${el.y}%;opacity:${el.presence};display:grid;grid-template-columns:repeat(${el.rows[0].length},${el.px}px);grid-auto-rows:${el.px}px;`;
  el.rows.forEach((row, ri) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === ".") continue;
      const b = document.createElement("span");
      b.style.cssText = `grid-column:${c + 1};grid-row:${ri + 1};background:${color ?? (ch === "e" ? el.edge ?? el.base : el.base)};`;
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
    // per-load seed: deterministic within the visit, fresh each load
    const loadSeed = (Date.now() % 100000) + (zone === "hero" ? 41 : 97);

    let timers: ReturnType<typeof setTimeout>[] = [];
    let ambient: ReturnType<typeof setTimeout>[] = [];
    let live: { d: HTMLElement; el: El }[] = [];
    let retuneAt = 0;
    let pendingT: ReturnType<typeof setTimeout> | undefined;
    const clearAll = (arr: ReturnType<typeof setTimeout>[]) =>
      arr.splice(0).forEach(clearTimeout);
    const wipe = () => {
      clearAll(timers);
      clearAll(ambient);
      live.splice(0).forEach((e) => e.d.remove());
    };

    /* ---- ambient: glimmer, meteors, birds — all rerolled intervals ---- */
    const startAmbient = () => {
      if (reduced) return;
      clearAll(ambient);
      // GLIMMER: per-star randomized period 4–8s, stepped 5-frame cycle
      live.forEach(({ d, el }) => {
        if (el.kind === "cloud") return;
        const cycle = () => {
          ambient.push(
            setTimeout(() => {
              const steps = [0.6, 0.85, 1, 1, el.presence]; // dim→mid→bright→hold→rest
              steps.forEach((o, i) =>
                ambient.push(setTimeout(() => (d.style.opacity = String(o)), i * 90)),
              );
              cycle();
            }, rnd(4000, 8000)),
          );
        };
        ambient.push(setTimeout(cycle, rnd(0, 4000))); // random phase
      });
      // METEOR (phosphor): first 8–20s, then reroll 30–90s
      const meteor = (first: boolean) => {
        ambient.push(
          setTimeout(() => {
            if (!document.hidden && theme() === "phosphor") {
              const s = renderEl(
                { x: rnd(8, 60), y: rnd(4, 26), rows: ["##", ".##"], base: "rgb(var(--ink) / 0.75)", px: 3, presence: 1, kind: "dust" },
                host,
              );
              let f = 0;
              const step = () => {
                f++;
                s.style.transform = `translate(${f * 16}px, ${f * 11}px)`;
                s.style.opacity = f > 5 ? "0.3" : "1";
                if (f < 9) ambient.push(setTimeout(step, 70));
                else s.remove();
              };
              step();
            }
            meteor(false);
          }, first ? rnd(8000, 20000) : rnd(30000, 90000)),
        );
      };
      // BIRDS (paper): cross the whole sky, 2-frame flap, drift; groups 1/3
      const bird = (first: boolean) => {
        ambient.push(
          setTimeout(() => {
            if (!document.hidden && theme() === "paper") {
              const n = Math.random() < 1 / 3 ? Math.round(rnd(2, 3)) : 1;
              const dur = rnd(25000, 40000);
              const stepMs = 120;
              const total = Math.round(dur / stepMs);
              for (let i = 0; i < n; i++) {
                const y0 = rnd(6, 34);
                const wob = rnd(0.5, 1.4);
                const s = renderEl(
                  { x: -6, y: y0 + i * 4, rows: ["#..#", ".##."], base: "rgb(var(--ink) / 0.55)", px: 3, presence: 1, kind: "dust" },
                  host,
                );
                const W = host.getBoundingClientRect().width;
                let f = 0;
                const fly = () => {
                  f++;
                  const flap = Math.floor(f / 3) % 2;
                  s.style.transform = `translate(${(f / total) * (W * 1.12)}px, ${Math.sin(f / 9) * 8 * wob}px)`;
                  // 2-frame flap: swap wing row visibility
                  (s.children[0] as HTMLElement).style.opacity = flap ? "0" : "1";
                  (s.children[1] as HTMLElement).style.opacity = flap ? "0" : "1";
                  (s.children[2] as HTMLElement).style.opacity = flap ? "1" : "0";
                  (s.children[3] as HTMLElement).style.opacity = flap ? "1" : "0";
                  if (f < total && !document.hidden) ambient.push(setTimeout(fly, stepMs));
                  else s.remove();
                };
                ambient.push(setTimeout(fly, i * 900));
              }
            }
            bird(false);
          }, first ? rnd(6000, 14000) : rnd(25000, 80000)),
        );
      };
      meteor(true);
      bird(true);
    };

    /* ---- materialize (instant or misconvergence) ---- */
    const appear = (instant: boolean) => {
      const set = buildSet(theme(), loadSeed);
      if (instant) {
        live = set.map((el) => ({ d: renderEl(el, host), el }));
        startAmbient();
        return;
      }
      const order = set.map((_, i) => i).sort(() => 0.5 - Math.random());
      let done = 0;
      order.forEach((idx, k) => {
        timers.push(
          setTimeout(() => {
            const el = set[idx];
            const copies = RGB.map((c) => renderEl(el, host, c));
            copies.forEach((cp) => (cp.style.opacity = "1"));
            let f = 0;
            const FRAMES = 6;
            const conv = () => {
              f++;
              const amp = Math.max(0, (FRAMES - f) * 0.7);
              copies.forEach((cp, ci) => {
                const dx = Math.round((Math.random() * 2 - 1) * amp * el.px);
                const dy = Math.round((Math.random() * 2 - 1) * amp * el.px);
                cp.style.transform = `translate(${dx + (ci - 1) * amp * 2}px, ${dy}px)`;
              });
              if (f < FRAMES) timers.push(setTimeout(conv, 75));
              else {
                copies.forEach((cp) => cp.remove());
                live.push({ d: renderEl(el, host), el });
                if (++done === set.length) startAmbient();
              }
            };
            conv();
          }, Math.round((k / order.length) * 1800)),
        );
      });
    };

    /* ---- the retune clock (pausable) ---- */
    const schedule = () => {
      if (pendingT) clearTimeout(pendingT);
      if (!retuneAt || document.hidden) return;
      pendingT = setTimeout(() => {
        retuneAt = 0;
        appear(false);
      }, Math.max(0, retuneAt - Date.now()));
    };
    const onSwitch = () => {
      wipe();
      if (reduced) {
        appear(true);
        return;
      }
      retuneAt = Date.now() + rnd(3500, 4000);
      schedule();
    };
    const onVis = () => {
      if (document.hidden && pendingT) {
        clearTimeout(pendingT);
        retuneAt = Date.now() + Math.max(0, retuneAt - Date.now());
      } else if (!document.hidden) schedule();
    };

    appear(true);
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
      className="pointer-events-none absolute inset-0 select-none"
    />
  );
}
