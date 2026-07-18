"use client";
import { useEffect, useRef } from "react";

/**
 * THE SKY — space-grade pixel weather for the marketing poster zones.
 *
 * LIFECYCLE: one registry owns every transient the sky can create — stars,
 * twinkle frames, ray tips, nebula, clouds, birds (and flap frames),
 * meteors, RGB convergence copies, taper-bleed elements. Every element is
 * spawned through one factory that tags it with the theme that created it
 * (data-sky-theme) and registers it; every timer goes through one
 * scheduler. A theme switch calls exactly one function, wipeAll(): walk
 * the registry, remove every element, cancel every timer. No per-type
 * cleanup paths exist to forget. A settle WATCHDOG sweeps every ~1s and
 * force-removes any element tagged with a stale theme or wearing signal
 * RGB outside an active convergence — whatever leaked, however it leaked,
 * the same net catches it.
 *
 * PHOSPHOR PALETTE (sky-layer-bounded exception, like the retune's RGB):
 * stars in bright SILVER (#EDEAE3 range) and LIGHT STEEL BLUE (#8FAECC
 * range), plus ≤3 rare amber heroes per zone — amber stays special. The
 * field is meant to be UNMISSABLE at a glance: a real night sky, resting
 * at full brightness, hierarchy carried by sprite size not dimness.
 * These colors never appear outside the sky layer.
 *
 * THE NEBULA: one per zone — a large flat-block dithered mass in 3 shades
 * of blue-tinted near-black barely above #0c0c0d, behind the stars,
 * static. Felt more than seen. No CSS gradients anywhere.
 *
 * DISTRIBUTION: blue-noise-ish — a coarse cell grid (max 1 star/cell,
 * shuffled) spreads ~55 stars/zone evenly across the full width and
 * height; presence fades only near the content edge, and a few stars
 * bleed past the zone boundary (the horizon taper). Seeded per page load.
 *
 * PAPER: ~7 ink clouds/zone (obvious at a glance: ~15% ink fill, ~20%
 * interior second shade, ~30% bottom edge) + birds crossing the full sky.
 *
 * HARD TEXT EXCLUSION: at mount and on resize, the actual bounding boxes
 * of every text block/CTA in the zone are measured, padded 60px, and no
 * star or nebula may seed inside them — nothing twinkles near a word.
 *
 * Everything else holds: per-star randomized glimmer, meteors 30-90s /
 * birds 25-80s rerolled, the RETUNE (user switches only: hard cut →
 * 3.5-4s genuine emptiness → staggered materialization via three
 * signal-RGB pixel-block copies converging in 75ms steps, settling into
 * this palette), reduced-motion instant-static, flat blocks only.
 */

type Rect = { l: number; t: number; r: number; b: number };
type El = {
  x: number;
  y: number;
  rows: string[];
  base: string;
  inner?: string;
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
  // 'i' = interior second shade, 'e' = darker bottom edge
  cloudA: ["..####..", ".#iiii#.", "#iiiiii#", "eeeeeeee"],
  cloudB: [".###.", "#iii#", "eeeee"],
  cloudC: ["..####..##.", ".#iiii##ii#", "#iiiiiiiii#", ".eeeeeeeee."],
};
// sky-only star inks (never in chrome/text/icons)
const SILVER = ["#EDEAE3", "#D6D3CA"];
const BLUE = ["#8FAECC", "#7C9BC0", "#5F82A6"];
const NEBULA = ["#0d0e11", "#0e1014", "#0f1218"]; // barely above #0c0c0d
const RGB = ["#ff0000", "#00ff00", "#0000ff"];
const RGB_RE = /rgb\(255, 0, 0\)|rgb\(0, 255, 0\)|rgb\(0, 0, 255\)/;
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
  exSoft: Rect[] = ex,
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
      // felt-not-seen: the dither is laid down as a few random-walk BLOBS,
      // each a contiguous irregular cluster in one shade — organic patches
      // that read as depth, never an alternating-cell checkerboard
      const GC = 16, GR = 9;
      const grid: number[][] = Array.from({ length: GR }, () => Array(GC).fill(-1));
      for (let bi = 0; bi < 7; bi++) {
        const sh = bi % 3;
        let cx = Math.floor(2 + r() * (GC - 4));
        let cy = Math.floor(1 + r() * (GR - 2));
        const size = 5 + Math.floor(r() * 8);
        for (let st = 0; st < size; st++) {
          if (Math.hypot((cx - 7.5) / 8, (cy - 4) / 4.5) < 0.95) grid[cy][cx] = sh;
          const dir = Math.floor(r() * 4);
          cx = Math.max(0, Math.min(GC - 1, cx + (dir === 0 ? 1 : dir === 1 ? -1 : 0)));
          cy = Math.max(0, Math.min(GR - 1, cy + (dir === 2 ? 1 : dir === 3 ? -1 : 0)));
        }
      }
      // encode shades via three separate elements (one per shade, flat)
      for (let sh = 0; sh < 3; sh++) {
        const shRows = Array.from({ length: GR }, (_, ri) =>
          Array.from({ length: GC }, (_, c) => (grid[ri][c] === sh ? "#" : ".")).join(""),
        );
        els.push({ x: spot.x, y: spot.y, rows: shRows, base: NEBULA[sh], px: 14, presence: 1, kind: "nebula" });
      }
    }

    // STARS: clustered-random — the grid only guards against gross
    // clumping; per-cell counts are probabilistic (some cells empty, most
    // 1, occasional 2), jitter spans the whole cell, and dust sometimes
    // brings close companions. Real skies clump; no detectable rhythm.
    const COLS = 13, ROWS = 9; // rows 0-7 cover 0-100%, row 8 = the bleed band
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
    const putStar = (x: number, y: number, bleed: boolean) => {
      // pyramid tiers: 1 big · 4 four-pointed · 9 diamonds · 14 dot2 · rest dust
      const kind: El["kind"] =
        placed === 0 ? "big"
        : placed <= 4 ? "hero"
        : placed <= 13 ? "mid"
        : placed <= 27 ? "dot2"
        : "dust";
      // amber stays special: the big one + two four-pointed (≤3/zone)
      const isAmber = kind === "big" || (kind === "hero" && heroes < 2);
      const base = isAmber
        ? "rgb(var(--phosphor-rgb))"
        : placed % 10 < 5
          ? SILVER[placed % 2]
          : BLUE[placed % 3];
      const nearContent = y > 80 && y <= 100; // the last ~150px
      // resting brightness is FULL — the sky must read at a glance;
      // hierarchy comes from sprite size, not from dimming the small tiers
      const tierPresence =
        kind === "big" || kind === "hero" || kind === "mid" ? 1 : kind === "dot2" ? 0.92 : 0.85;
      els.push({
        x, y,
        rows: SPRITES[kind as "dust" | "dot2" | "mid" | "hero" | "big"],
        base,
        px: 3,
        presence: bleed ? 0.35 : nearContent ? 0.5 : tierPresence,
        kind,
      });
      if (isAmber) heroes++;
      if (bleed) bleeds++;
      placed++;
      return kind;
    };
    for (const cell of cells) {
      if (placed >= 55) break;
      // probabilistic occupancy: sparse patches and denser patches
      const roll = r();
      const n = roll < 0.34 ? 0 : roll < 0.82 ? 1 : 2;
      for (let k = 0; k < n && placed < 55; k++) {
        if (cell.bleed && bleeds >= 8) break;
        let x = 0, y = 0, ok = false;
        for (let attempt = 0; attempt < 6 && !ok; attempt++) {
          // full-cell jitter — no center bias
          x = (cell.cx + r()) * (100 / COLS);
          y = cell.bleed
            ? 100 + r() * 18
            : (cell.cy + r()) * (100 / (ROWS - 1));
          ok = !ex.some((rc) => inRect(x, y, rc));
        }
        if (!ok) continue;
        const kind = putStar(x, y, cell.bleed);
        // loose dust pairs/triples: close but never touching
        if (kind === "dust" && !cell.bleed && r() < 0.3) {
          const mates = r() < 0.3 ? 2 : 1;
          for (let m = 0; m < mates && placed < 55; m++) {
            const mx = x + (r() < 0.5 ? -1 : 1) * (1.2 + r() * 2.6);
            const my = y + (r() < 0.5 ? -1 : 1) * (1.8 + r() * 3.6);
            if (mx < 0 || mx > 99 || my < 0 || my > 100) continue;
            if (ex.some((rc) => inRect(mx, my, rc))) continue;
            putStar(mx, my, false);
          }
        }
      }
    }
  } else {
    // paper: obvious ink clouds (fill + interior shade + bottom edge),
    // spread on an even column grid — one cloud per slot, never clumped
    const SLOTS = 7;
    const slots = Array.from({ length: SLOTS }, (_, i) => i);
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    const shapes = [SPRITES.cloudA, SPRITES.cloudB, SPRITES.cloudC];
    // probabilistic occupancy like the stars: some slots empty, most 1,
    // occasional 2 — sparse stretches and denser stretches, no rhythm
    let made = 0;
    slots.forEach((slot, i) => {
      if (made >= 8) return;
      const roll = r();
      const n = roll < 0.22 ? 0 : roll < 0.78 ? 1 : 2;
      for (let k = 0; k < n && made < 8; k++) {
        // clouds are soft ink washes, not twinkling pixels: they use the
        // gentler exclusion pad and may sit anywhere in the zone's height
        let x = 0, y = 0, ok = false;
        for (let attempt = 0; attempt < 24 && !ok; attempt++) {
          x = (slot + r()) * (88 / SLOTS); // full-slot jitter
          y = r() * 100;
          ok = !exSoft.some((rc) => inRect(x, y, rc, 2));
        }
        if (!ok) continue;
        els.push({
          x, y,
          rows: shapes[(i + k) % 3],
          base: "rgb(var(--ink) / 0.16)",
          inner: "rgb(var(--ink) / 0.22)",
          edge: "rgb(var(--ink) / 0.32)",
          px: 7,
          presence: y > 78 ? 0.7 : 1,
          kind: "cloud",
        });
        made++;
      }
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
      const shade =
        ch === "e" ? el.edge ?? el.base : ch === "i" ? el.inner ?? el.base : el.base;
      b.style.cssText = `grid-column:${c + 1};grid-row:${ri + 1};background:${color ?? shade};${ch === "t" && !color ? "visibility:hidden;" : ""}`;
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

    /* ---- THE REGISTRY: every transient element and timer, one place ---- */
    const reg = {
      els: new Set<HTMLElement>(),
      timers: new Set<ReturnType<typeof setTimeout>>(),
    };
    let live: { d: HTMLElement; el: El }[] = [];
    // true only while an RGB convergence is legitimately on screen — the
    // watchdog spares signal RGB during it and kills it any other time
    let retuneBusy = false;
    let retuneAt = 0;
    let pendingT: ReturnType<typeof setTimeout> | undefined;

    /** the ONLY element factory: theme-tag + register at creation */
    const spawn = (el: El, opts?: { color?: string; fx?: string }) => {
      const d = renderEl(el, host, opts?.color);
      d.dataset.skyTheme = theme();
      if (opts?.fx) d.dataset.fx = opts.fx;
      reg.els.add(d);
      return d;
    };
    const kill = (d: HTMLElement) => {
      d.remove();
      reg.els.delete(d);
    };
    /** the ONLY scheduler: every timer is registered and wipeable */
    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        reg.timers.delete(t);
        fn();
      }, ms);
      reg.timers.add(t);
      return t;
    };
    /** THE one teardown — a theme switch calls this and nothing else */
    const wipeAll = () => {
      reg.timers.forEach(clearTimeout);
      reg.timers.clear();
      reg.els.forEach((d) => d.remove());
      reg.els.clear();
      live = [];
      retuneBusy = false;
    };
    /** settle WATCHDOG: every ~1s, remove anything tagged with a stale
     *  theme or wearing signal RGB outside an active convergence — the
     *  same net catches every possible leak, regardless of source */
    const sweep = () => {
      const cur = theme();
      host.querySelectorAll<HTMLElement>("[data-sky-theme]").forEach((d) => {
        const staleTheme = d.dataset.skyTheme !== cur;
        const rgbStray =
          !retuneBusy &&
          RGB_RE.test(
            (d.firstElementChild as HTMLElement | null)?.style.background ?? "",
          );
        if (staleTheme || rgbStray) kill(d);
      });
    };
    const watchdog = setInterval(sweep, 1000);

    /* measured text/CTA exclusion: real rects, padded, in zone % */
    const exRects = (pad: number): Rect[] => {
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
          l: ((r.left - pad - hr.left) / hr.width) * 100,
          t: ((r.top - pad - hr.top) / hr.height) * 100,
          r: ((r.right + pad - hr.left) / hr.width) * 100,
          b: ((r.bottom + pad - hr.top) / hr.height) * 100,
        });
      });
      return out.filter((rc) => rc.r > 0 && rc.l < 100 && rc.b > 0);
    };

    /* ---- ambient (all through spawn/later — registry-owned) ---- */
    const startAmbient = () => {
      if (reduced) return;
      live.forEach(({ d, el }) => {
        if (el.kind === "cloud" || el.kind === "nebula") return;
        const bigTier = el.kind === "hero" || el.kind === "big";
        const brightCap = bigTier || el.kind === "mid" ? 1 : 0.95;
        const tips = [...d.querySelectorAll<HTMLElement>("[data-tip]")];
        const cycle = () => {
          later(() => {
            const steps = [0.65, 0.85, brightCap, brightCap, el.presence];
            steps.forEach((o, i) =>
              later(() => {
                d.style.opacity = String(o);
                // classic pixel sparkle: tips extend on the two bright
                // frames, then retract
                if (bigTier && tips.length)
                  tips.forEach((t) => (t.style.visibility = i === 2 || i === 3 ? "visible" : "hidden"));
              }, i * 90),
            );
            cycle();
          }, rnd(4000, 8000));
        };
        later(cycle, rnd(0, 4000));
      });
      const meteor = (first: boolean) => {
        later(() => {
          if (!document.hidden && theme() === "phosphor") {
            const s = spawn(
              { x: rnd(8, 60), y: rnd(4, 26), rows: ["##", ".##"], base: SILVER[0], px: 3, presence: 1, kind: "dust" },
              { fx: "meteor" },
            );
            let f = 0;
            const step = () => {
              f++;
              s.style.transform = `translate(${f * 16}px, ${f * 11}px)`;
              s.style.opacity = f > 5 ? "0.3" : "1";
              if (f < 9) later(step, 70);
              else kill(s);
            };
            step();
          }
          meteor(false);
        }, first ? rnd(8000, 20000) : rnd(30000, 90000));
      };
      const bird = (first: boolean) => {
        later(() => {
          if (!document.hidden && theme() === "paper") {
            const n = Math.random() < 1 / 3 ? Math.round(rnd(2, 3)) : 1;
            const dur = rnd(25000, 40000);
            const stepMs = 120;
            const total = Math.round(dur / stepMs);
            for (let i = 0; i < n; i++) {
              const y0 = rnd(6, 34);
              const wob = rnd(0.5, 1.4);
              const s = spawn(
                { x: -6, y: y0 + i * 4, rows: ["#..#", ".##."], base: "rgb(var(--ink) / 0.55)", px: 3, presence: 1, kind: "dust" },
                { fx: "bird" },
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
                if (f < total && !document.hidden) later(fly, stepMs);
                else kill(s);
              };
              later(fly, i * 900);
            }
          }
          bird(false);
        }, first ? rnd(6000, 14000) : rnd(25000, 80000));
      };
      meteor(true);
      bird(true);
    };

    /* ---- materialize ---- */
    const appear = (instant: boolean) => {
      // materialization ALWAYS starts from a wiped registry — a stray extra
      // call (whatever schedules it) can double nothing
      wipeAll();
      const set = buildSet(theme(), loadSeed, exRects(60), exRects(40));
      if (instant) {
        live = set.map((el) => ({ d: spawn(el), el }));
        startAmbient();
        return;
      }
      retuneBusy = true;
      // failsafe: whatever happens, the busy window is bounded — after it,
      // any surviving signal RGB is stray by definition and gets swept
      later(() => {
        retuneBusy = false;
        sweep();
      }, 6000);
      const order = set.map((_, i) => i).sort(() => 0.5 - Math.random());
      let done = 0;
      order.forEach((idx, k) => {
        later(() => {
          const el = set[idx];
          if (el.kind === "nebula") {
            // the nebula fades no signal: it simply is, once the sky returns
            live.push({ d: spawn(el), el });
            if (++done === set.length) startAmbient();
            return;
          }
          const copies = RGB.map((c) => spawn(el, { color: c }));
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
            if (f < FRAMES) later(conv, 75);
            else {
              copies.forEach(kill);
              live.push({ d: spawn(el), el });
              if (++done === set.length) {
                retuneBusy = false;
                startAmbient();
                // settle: assert-clean 1s after the retune completes
                later(sweep, 1000);
              }
            }
          };
          conv();
        }, Math.round((k / order.length) * 1800));
      });
    };

    /* ---- retune clock ---- */
    const schedule = () => {
      if (pendingT) clearTimeout(pendingT);
      if (!retuneAt || document.hidden) return;
      pendingT = setTimeout(() => {
        // the clock is fully consumed BEFORE materializing: a fired retune
        // leaves nothing behind for onVis to resurrect
        pendingT = undefined;
        retuneAt = 0;
        appear(false);
      }, Math.max(0, retuneAt - Date.now()));
    };
    const onSwitch = () => {
      wipeAll();
      if (reduced) {
        appear(true);
        return;
      }
      retuneAt = Date.now() + rnd(3500, 4000);
      schedule();
    };
    const onVis = () => {
      if (document.hidden) {
        if (pendingT) {
          clearTimeout(pendingT);
          pendingT = undefined;
        }
        // freeze the countdown ONLY while a retune is genuinely pending —
        // retuneAt=0 must stay 0 or tab-show would conjure a phantom retune
        if (retuneAt) retuneAt = Date.now() + Math.max(0, retuneAt - Date.now());
      } else if (retuneAt) schedule();
    };
    // measured exclusion must track layout: rebuild statically on resize
    let rz: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(rz);
      rz = setTimeout(() => {
        if (retuneAt) return; // don't fight a pending retune
        wipeAll();
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
      clearInterval(watchdog);
      wipeAll();
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
