"use client";
import { useEffect, useRef } from "react";

/**
 * THE SKY — space-grade pixel weather for the marketing poster zones.
 *
 * PHOSPHOR PALETTE (sky-layer-bounded exception, like the retune's RGB):
 * stars in SILVER (dim desaturated off-white steps) and DIM BLUE
 * (desaturated steel range #5B7A9E → #2E4257), ~50/40, plus 2-3 rare amber
 * heroes per zone (~10%) — amber stays special. These colors never appear
 * outside the sky layer. Paper mode unchanged (ink-tinted clouds, birds).
 *
 * THE NEBULA: one per zone — a large flat-block dithered mass in 3 shades
 * of blue-tinted near-black barely above #0c0c0d, behind the stars,
 * static. Felt more than seen: the black has depth; the dither IS the
 * gradient. No CSS gradients anywhere.
 *
 * DISTRIBUTION: blue-noise-ish — a coarse cell grid (max 1 star/cell,
 * shuffled) spreads ~25 stars/zone evenly across the full width and
 * height; presence fades only near the content edge, and a few stars
 * bleed past the zone boundary (the horizon taper). Seeded per page load.
 *
 * HARD TEXT EXCLUSION: at mount and on resize, the actual bounding boxes
 * of every text block/CTA in the zone are measured, padded 60px, and no
 * star or nebula may seed inside them — nothing twinkles near a word.
 *
 * Everything else holds: sprite depth mix, per-star randomized glimmer,
 * meteors 30-90s / birds 25-80s rerolled, the RETUNE (user switches only:
 * hard cut → 3.5-4s genuine emptiness → staggered materialization via
 * three signal-RGB pixel-block copies converging in 75ms steps, settling
 * into this palette), reduced-motion instant-static, flat blocks only.
 */

type Rect = { l: number; t: number; r: number; b: number };
type El = {
  x: number;
  y: number;
  rows: string[];
  base: string;
  edge?: string;
  px: number;
  presence: number;
  kind: "dust" | "dot2" | "mid" | "hero" | "big" | "cloud" | "nebula";
};

const SPRITES = {
  dust: ["#"],
  dot2: ["##"],
  mid: [".#.", "###", ".#."],
  // four-pointed, with 't' = ray-extension tips shown on the bright frame
  hero: [
    "...t...",
    "...#...",
    "..###..",
    "t#####t",
    "..###..",
    "...#...",
    "...t...",
  ],
  big: [
    "....t....",
    "....#....",
    "....#....",
    "...###...",
    "t#######t",
    "...###...",
    "....#....",
    "....#....",
    "....t....",
  ],
  cloudA: ["..####..", "########", "eeeeeeee"],
  cloudB: [".###.", "#####", "eeeee"],
};
// sky-only star inks (never in chrome/text/icons)
const SILVER = ["#d9d9d3", "#b8b8b0"];
const BLUE = ["#7C9BC0", "#5B7A9E", "#48607A"];
const NEBULA = ["#0e1014", "#101318", "#131822"]; // barely above #0c0c0d
const RGB = ["#ff0000", "#00ff00", "#0000ff"];
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

function prng(seed: number) {
  let s = seed % 2147483647 || 7;
  return () => ((s = (s * 16807) % 2147483647) & 0x7fffffff) / 2147483647;
}
const inRect = (x: number, y: number, rc: Rect, m = 2) =>
  x > rc.l - m && x < rc.r + m && y > rc.t - m && y < rc.b + m;

function buildSet(
  theme: "phosphor" | "paper",
  seed: number,
  ex: Rect[],
): El[] {
  const r = prng(seed);
  const els: El[] = [];

  if (theme === "phosphor") {
    // NEBULA first (behind): try candidate centers that clear the text rects
    const spots = [
      { x: 8, y: 8 }, { x: 60, y: 6 }, { x: 30, y: 70 }, { x: 68, y: 78 },
      { x: 4, y: 46 }, { x: 78, y: 40 },
    ];
    const W = 30, H = 26; // % footprint
    const spot = spots.find(
      (s) => !ex.some((rc) => !(s.x + W < rc.l || s.x > rc.r || s.y + H < rc.t || s.y > rc.b)),
    );
    if (spot) {
      // dithered mass: 16x9 cells, density falls off from center, 3 shades
      const rows: string[] = [];
      const shadeRows: string[] = [];
      for (let ri = 0; ri < 9; ri++) {
        let row = "", srow = "";
        for (let c = 0; c < 16; c++) {
          const d = Math.hypot((c - 7.5) / 8, (ri - 4) / 4.5);
          const p = Math.max(0, 0.85 - d);
          if (r() < p) { row += "#"; srow += String(Math.min(2, Math.floor(r() * 3))); }
          else { row += "."; srow += "."; }
        }
        rows.push(row); shadeRows.push(srow);
      }
      // encode shades via three separate elements (one per shade, flat)
      for (let sh = 0; sh < 3; sh++) {
        const shRows = rows.map((row, ri) =>
          row.split("").map((ch, c) => (ch === "#" && shadeRows[ri][c] === String(sh) ? "#" : ".")).join(""),
        );
        els.push({ x: spot.x, y: spot.y, rows: shRows, base: NEBULA[sh], px: 14, presence: 1, kind: "nebula" });
      }
    }

    // STARS: coarse grid, max 1/cell, even coverage + horizon bleed
    const COLS = 11, ROWS = 8; // rows 0-6 cover 0-100%, row 7 = the bleed band
    const cells: { cx: number; cy: number; bleed: boolean }[] = [];
    for (let ri = 0; ri < ROWS; ri++)
      for (let c = 0; c < COLS; c++)
        cells.push({ cx: c, cy: ri, bleed: ri === ROWS - 1 });
    // shuffle deterministically
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    let placed = 0, heroes = 0, bleeds = 0;
    for (const cell of cells) {
      if (placed >= 38) break;
      if (cell.bleed && bleeds >= 6) continue;
      let x = 0, y = 0, ok = false;
      for (let attempt = 0; attempt < 6 && !ok; attempt++) {
        x = (cell.cx + 0.15 + r() * 0.7) * (100 / COLS);
        y = cell.bleed
          ? 100 + r() * 18
          : (cell.cy + 0.15 + r() * 0.7) * (100 / (ROWS - 1));
        ok = !ex.some((rc) => inRect(x, y, rc));
      }
      if (!ok) continue;
      // pyramid tiers: 1 big · 2 four-pointed · 4 diamonds · 6 dot2 · rest dust
      const kind: El["kind"] =
        placed === 0 ? "big"
        : placed <= 3 ? "hero"
        : placed <= 9 ? "mid"
        : placed <= 18 ? "dot2"
        : "dust";
      // amber stays special: the big one + one four-pointed (≤3/zone)
      const isAmber = (kind === "big" || (kind === "hero" && heroes < 1)) && placed % 1 === 0;
      const base = isAmber
        ? "rgb(var(--phosphor-rgb))"
        : placed % 10 < 5
          ? SILVER[placed % 2]
          : BLUE[placed % 3];
      const nearContent = y > 80 && y <= 100; // the last ~150px
      const tierPresence =
        kind === "big" ? 1 : kind === "hero" ? 0.95 : kind === "mid" ? 0.8 : kind === "dot2" ? 0.68 : 0.55;
      els.push({
        x, y,
        rows: SPRITES[kind as "dust" | "dot2" | "mid" | "hero" | "big"],
        base,
        px: 3,
        presence: cell.bleed ? 0.15 : nearContent ? 0.3 : tierPresence,
        kind,
      });
      if (isAmber) heroes++;
      if (cell.bleed) bleeds++;
      placed++;
    }
  } else {
    // paper unchanged: clouds with measured exclusion
    let guard = 0, made = 0;
    while (made < 6 && guard++ < 80) {
      const x = 2 + r() * 78;
      const y = Math.pow(r(), 1.6) * 105 * 0.7;
      if (ex.some((rc) => inRect(x, y, rc, 4))) continue;
      els.push({
        x, y,
        rows: made % 2 ? SPRITES.cloudB : SPRITES.cloudA,
        base: "rgb(var(--ink) / 0.10)",
        edge: "rgb(var(--ink) / 0.22)",
        px: 6,
        presence: y > 70 ? 0.4 : 1,
        kind: "cloud",
      });
      made++;
    }
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
      b.style.cssText = `grid-column:${c + 1};grid-row:${ri + 1};background:${color ?? (ch === "e" ? el.edge ?? el.base : el.base)};${ch === "t" && !color ? "visibility:hidden;" : ""}`;
      if (ch === "t") b.dataset.tip = "1";
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
    const loadSeed = (Date.now() % 100000) + (zone === "hero" ? 41 : 97);

    let timers: ReturnType<typeof setTimeout>[] = [];
    let ambient: ReturnType<typeof setTimeout>[] = [];
    let live: { d: HTMLElement; el: El }[] = [];
    // ROOT CAUSE of stuck RGB: convergence copies were appended to the host
    // but never tracked, so wipe() (rapid toggle / cancel) cleared their
    // finishing timers and left the R/G/B divs orphaned on screen. Track
    // every copy so cancellation removes them with everything else.
    let copiesLive: HTMLElement[] = [];
    let retuneAt = 0;
    let pendingT: ReturnType<typeof setTimeout> | undefined;
    const clearAll = (arr: ReturnType<typeof setTimeout>[]) =>
      arr.splice(0).forEach(clearTimeout);
    const watchdogs: ReturnType<typeof setTimeout>[] = [];
    const timersSafe = (t: ReturnType<typeof setTimeout>) => watchdogs.push(t);
    const sweepStrays = () => {
      // HARD GUARANTEE (settle watchdog): force-remove anything still
      // wearing signal RGB, unconditionally.
      copiesLive.splice(0).forEach((c) => c.remove());
      host.querySelectorAll("div").forEach((d) => {
        const bg = (d.firstElementChild as HTMLElement | null)?.style.background ?? "";
        if (/rgb\(255, 0, 0\)|rgb\(0, 255, 0\)|rgb\(0, 0, 255\)/.test(bg)) d.remove();
      });
    };
    const wipe = () => {
      clearAll(timers);
      clearAll(ambient);
      live.splice(0).forEach((e) => e.d.remove());
      sweepStrays();
      // watchdog: even after a clean-looking cancel, re-sweep 1s later
      setTimeout(sweepStrays, 1000);
    };

    /* measured text/CTA exclusion: real rects, padded 60px, in zone % */
    const exRects = (): Rect[] => {
      const hr = host.getBoundingClientRect();
      if (!hr.width || !hr.height) return [];
      // tight leaf boxes: the h1 is a flex-grow container that spans the
      // zone - measuring it would exclude everything. Its beat spans are
      // the real text.
      const els = host.parentElement!.querySelectorAll(
        "h1 > span, h2, h3, p, a, button, dl",
      );
      const out: Rect[] = [];
      els.forEach((e) => {
        if (host.contains(e)) return;
        const r = e.getBoundingClientRect();
        if (!r.width) return;
        out.push({
          l: ((r.left - 60 - hr.left) / hr.width) * 100,
          t: ((r.top - 60 - hr.top) / hr.height) * 100,
          r: ((r.right + 60 - hr.left) / hr.width) * 100,
          b: ((r.bottom + 60 - hr.top) / hr.height) * 100,
        });
      });
      return out.filter((rc) => rc.r > 0 && rc.l < 100 && rc.b > 0);
    };

    /* ---- ambient (unchanged behaviors) ---- */
    const startAmbient = () => {
      if (reduced) return;
      clearAll(ambient);
      live.forEach(({ d, el }) => {
        if (el.kind === "cloud" || el.kind === "nebula") return;
        const bigTier = el.kind === "hero" || el.kind === "big";
        const brightCap = bigTier ? 1 : el.kind === "mid" ? 0.85 : 0.7;
        const tips = [...d.querySelectorAll<HTMLElement>("[data-tip]")];
        const cycle = () => {
          ambient.push(
            setTimeout(() => {
              const steps = [0.6, 0.85, brightCap, brightCap, el.presence];
              steps.forEach((o, i) =>
                ambient.push(setTimeout(() => {
                  d.style.opacity = String(o);
                  // classic pixel sparkle: tips extend on the two bright
                  // frames, then retract
                  if (bigTier && tips.length)
                    tips.forEach((t) => (t.style.visibility = i === 2 || i === 3 ? "visible" : "hidden"));
                }, i * 90)),
              );
              cycle();
            }, rnd(4000, 8000)),
          );
        };
        ambient.push(setTimeout(cycle, rnd(0, 4000)));
      });
      const meteor = (first: boolean) => {
        ambient.push(
          setTimeout(() => {
            if (!document.hidden && theme() === "phosphor") {
              const s = renderEl(
                { x: rnd(8, 60), y: rnd(4, 26), rows: ["##", ".##"], base: SILVER[0], px: 3, presence: 1, kind: "dust" },
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

    /* ---- materialize ---- */
    const appear = (instant: boolean) => {
      const set = buildSet(theme(), loadSeed, exRects());
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
            if (el.kind === "nebula") {
              // the nebula fades no signal: it simply is, once the sky returns
              live.push({ d: renderEl(el, host), el });
              if (++done === set.length) startAmbient();
              return;
            }
            const copies = RGB.map((c) => renderEl(el, host, c));
            copies.forEach((cp) => {
              cp.style.opacity = "1";
              copiesLive.push(cp);
            });
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
                copies.forEach((cp) => {
                  cp.remove();
                  const i = copiesLive.indexOf(cp);
                  if (i >= 0) copiesLive.splice(i, 1);
                });
                live.push({ d: renderEl(el, host), el });
                if (++done === set.length) {
                  startAmbient();
                  // watchdog: 1s after the retune completes, assert-clean
                  timersSafe(setTimeout(sweepStrays, 1000));
                }
              }
            };
            conv();
          }, Math.round((k / order.length) * 1800)),
        );
      });
    };

    /* ---- retune clock ---- */
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
    // measured exclusion must track layout: rebuild statically on resize
    let rz: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(rz);
      rz = setTimeout(() => {
        if (retuneAt) return; // don't fight a pending retune
        wipe();
        appear(true);
      }, 300);
    };

    appear(true);
    addEventListener("b0-theme-switch", onSwitch);
    addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      removeEventListener("b0-theme-switch", onSwitch);
      removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVis);
      if (pendingT) clearTimeout(pendingT);
      clearTimeout(rz);
      watchdogs.forEach(clearTimeout);
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
