/**
 * Screenshot every live-room harness state (/dev/live) at desktop, phone and
 * narrow-phone (320px) sizes and check the layout: control bar on screen with
 * every control inside it, nothing over it but its own menus, notices and
 * toasts stacked (never on each other, the filmstrip, the side panel or the
 * main tile's Pin / Full screen buttons when they show), the side panel's own
 * controls uncovered, no sideways scroll, presentations never cropped, no
 * page errors. Phone sizes are touch screens (the main tile's actions always
 * shown; a filmstrip or PiP tile's only after a tap, so none show here).
 *
 *   npx next dev -p 3102
 *   E2E_BASE_URL=http://localhost:3102 npm run room-screens -- --out=/tmp/room-screens
 *   ... --only=presenting-deck,call-2:pin-self
 *
 * Exits non-zero when any state has a problem.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { HARNESS_STATES } from "../app/dev/live/states.ts";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const OUT = arg("out") ?? "/tmp/room-screens";
const ONLY = (arg("only") ?? "").split(",").filter(Boolean);
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
  // Android "display size" set large: 320 CSS pixels.
  { name: "narrow", width: 320, height: 700, touch: true },
];

// Runs in the page.
const CHECK = `(() => {
  const out = [];
  const vw = innerWidth, vh = innerHeight;
  const box = (el) => {
    const r = el && el.getBoundingClientRect();
    return r && r.width && r.height ? r : null;
  };
  const hit = (a, b) =>
    !!a && !!b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const shown = (el) => !!box(el) && getComputedStyle(el).visibility !== 'hidden';
  const bar = document.querySelector('[data-testid="room-controls"]');
  const br = box(bar);
  if (br && (br.bottom > vh + 0.5 || br.top < 0)) out.push('control bar off-screen');
  if (document.documentElement.scrollWidth > vw + 1) out.push('sideways scroll');
  const FLOATING = '[data-testid="stage-notices"] > :not([data-testid="room-toasts"]), [data-testid="room-toasts"] > *';
  if (br) {
    for (const el of document.querySelectorAll('[data-testid="side-panel"], [data-testid="stage-pip"], [data-testid="filmstrip"], [data-testid="stage-main"], ' + FLOATING)) {
      const r = box(el);
      if (r && r.bottom > br.top + 0.5 && r.top < br.bottom) out.push('over the bar: ' + (el.getAttribute('data-testid') || 'toast'));
    }
    for (const b of bar.querySelectorAll('button')) {
      const r = b.getBoundingClientRect();
      if (r.width && (r.left < -0.5 || r.right > vw + 0.5)) out.push('control off-screen: ' + (b.getAttribute('aria-label') || '?'));
    }
  }
  // Notices and toasts over the stage: never on the side panel, the filmstrip or each other.
  const panel = document.querySelector('[data-testid="side-panel"]');
  const pr = panel && shown(panel) ? box(panel) : null;
  const fr = box(document.querySelector('[data-testid="filmstrip"]'));
  const floating = [...document.querySelectorAll(FLOATING)].filter((el) => box(el) && !(panel && panel.contains(el)));
  const label = (el) => (el.closest('[data-testid="room-toasts"]') ? 'toast' : el.getAttribute('data-testid') || 'notice');
  for (const el of floating) {
    if (hit(box(el), pr)) out.push(label(el) + ' over the side panel');
    if (hit(box(el), fr)) out.push(label(el) + ' over the filmstrip');
  }
  for (let i = 0; i < floating.length; i++)
    for (let j = i + 1; j < floating.length; j++)
      if (hit(box(floating[i]), box(floating[j]))) out.push(label(floating[i]) + ' on ' + label(floating[j]));
  // Nor on the main tile's actions while they show (always, on touch screens).
  for (const a of document.querySelectorAll('[data-testid="tile-main"] [data-testid^="tile-pin"], [data-testid="tile-main"] [data-testid="tile-fullscreen"]')) {
    if (Number(getComputedStyle(a.parentElement).opacity) < 0.5) continue;
    for (const el of floating) if (hit(box(el), box(a))) out.push(label(el) + ' over ' + a.getAttribute('data-testid'));
  }
  // The side panel's own fields and buttons are reachable (nothing drawn on
  // them), unless a modal dialog is meant to cover the room.
  if (pr && !document.querySelector('[aria-modal="true"]')) {
    for (const el of panel.querySelectorAll('input, textarea, button')) {
      const r = box(el);
      if (!r) continue;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < pr.left || x > pr.right || y < pr.top || y > pr.bottom) continue;
      const top = document.elementFromPoint(x, y);
      if (top && !panel.contains(top)) {
        const what = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || el.tagName).trim().slice(0, 30);
        out.push('covered in the side panel: ' + what);
      }
    }
  }
  for (const v of document.querySelectorAll('[data-testid^="tile-"] video')) {
    const tile = v.closest('[data-testid^="tile-"]');
    if (/Presenting/.test(tile ? tile.textContent || '' : '') && getComputedStyle(v).objectFit !== 'contain') out.push('presentation cropped');
  }
  return [...new Set(out)];
})()`;

const launch = () =>
  chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-dev-shm-usage",
    ],
  });
/** Rejects after `ms`: a crashed renderer can leave a page call pending forever. */
const within = <T,>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))]);

let browser = await launch();
let failed = 0;
try {
  for (const [state, variants] of Object.entries(HARNESS_STATES)) {
    for (const w of variants) {
      if (ONLY.length && !ONLY.includes(state) && !ONLY.includes(`${state}:${w}`)) continue;
      for (const vp of VIEWPORTS) {
        if (!browser.isConnected()) browser = await launch();
        const ctx = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          hasTouch: vp.touch,
          isMobile: vp.touch,
        });
        const page = await ctx.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
        });
        let issues: string[] = [];
        try {
          await within(
            240_000,
            (async () => {
              await page.goto(`${BASE}/dev/live?state=${state}&w=${w}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
              await page.waitForSelector('[data-testid="room-shell"]', { timeout: 60_000 });
              await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
              if (state === "presenting-deck" && w !== "viewer") {
                // "behind": another host's screen holds the stage; our slides are a filmstrip card.
                const ready = w === "behind" ? '[data-testid="deck-thumb"]' : '[data-testid="deck-canvas"]';
                await page.waitForSelector(ready, { timeout: 60_000 });
              }
              await page.waitForTimeout(2500);
              issues = (await page.evaluate(CHECK)) as string[];
              await page.screenshot({ path: `${OUT}/${state}-${w}-${vp.name}.png` });
            })(),
          );
        } catch (e) {
          issues.push(`did not render: ${String(e).slice(0, 160)}`);
        }
        const all = [...issues, ...errors];
        if (all.length) failed++;
        console.log(`${all.length ? "✗" : "✓"} ${state}:${w} ${vp.name}${all.length ? `  ${all.join(" | ")}` : ""}`);
        await within(10_000, ctx.close()).catch(() => {});
      }
    }
  }
} finally {
  await within(10_000, browser.close()).catch(() => {});
}
console.log(`\n${failed ? `${failed} with problems` : "all clean"} · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
