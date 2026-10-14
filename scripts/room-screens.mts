/**
 * Screenshot every live-room harness state (/dev/live) at desktop and phone
 * sizes and check the layout: control bar on screen, nothing over it but its
 * own menus, no sideways scroll, presentations never cropped, no page errors.
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
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

// Runs in the page.
const CHECK = `(() => {
  const out = [];
  const vw = innerWidth, vh = innerHeight;
  const bar = document.querySelector('[data-testid="room-controls"]');
  const br = bar && bar.getBoundingClientRect();
  if (br && (br.bottom > vh + 0.5 || br.top < 0)) out.push('control bar off-screen');
  if (document.documentElement.scrollWidth > vw + 1) out.push('sideways scroll');
  if (br) {
    for (const el of document.querySelectorAll('[data-testid="side-panel"], [data-testid="room-toasts"] > *, [data-testid="stage-pip"], [data-testid="filmstrip"], [data-testid="stage-main"]')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && r.bottom > br.top + 0.5 && r.top < br.bottom) out.push('over the bar: ' + el.getAttribute('data-testid'));
    }
    for (const b of bar.querySelectorAll('button')) {
      const r = b.getBoundingClientRect();
      if (r.width && (r.left < -0.5 || r.right > vw + 0.5)) out.push('control off-screen: ' + (b.getAttribute('aria-label') || '?'));
    }
  }
  for (const v of document.querySelectorAll('[data-testid^="tile-"] video')) {
    const tile = v.closest('[data-testid^="tile-"]');
    if (/Presenting/.test(tile ? tile.textContent || '' : '') && getComputedStyle(v).objectFit !== 'contain') out.push('presentation cropped');
  }
  return out;
})()`;

const browser = await chromium.launch({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-dev-shm-usage",
  ],
});
let failed = 0;
try {
  for (const [state, variants] of Object.entries(HARNESS_STATES)) {
    for (const w of variants) {
      if (ONLY.length && !ONLY.includes(state) && !ONLY.includes(`${state}:${w}`)) continue;
      for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await ctx.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
        });
        let issues: string[] = [];
        try {
          await page.goto(`${BASE}/dev/live?state=${state}&w=${w}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
          await page.waitForSelector('[data-testid="room-shell"]', { timeout: 60_000 });
          await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
          if (state === "presenting-deck" && w !== "viewer") {
            await page.waitForSelector('[data-testid="deck-canvas"]', { timeout: 60_000 });
          }
          await page.waitForTimeout(2500);
          issues = (await page.evaluate(CHECK)) as string[];
          await page.screenshot({ path: `${OUT}/${state}-${w}-${vp.name}.png` });
        } catch (e) {
          issues.push(`did not render: ${String(e).slice(0, 160)}`);
        }
        const all = [...issues, ...errors];
        if (all.length) failed++;
        console.log(`${all.length ? "✗" : "✓"} ${state}:${w} ${vp.name}${all.length ? `  ${all.join(" | ")}` : ""}`);
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${failed ? `${failed} with problems` : "all clean"} · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
