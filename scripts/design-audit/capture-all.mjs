// batch0 design-audit capture. Screenshots every public page full-page at
// desktop (1440) and mobile (390), plus key interaction states. Scrolls the
// full height first (to trigger lazy sections / animate-rise), returns to
// top, settles, then captures — so nothing is caught half-rendered.
//
// Usage: node scripts/design-audit/capture-all.mjs [baseUrl] [outDir]
// The dev server must already be running (see .claude/launch.json → design-audit).
//
// Output PNGs are gitignored (docs/design-audit/shots/) but fully regenerable
// from this script.
import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const base = process.argv[2] ?? "http://localhost:3100";
const outDir = process.argv[3] ?? "docs/design-audit/shots";
mkdirSync(outDir, { recursive: true });

// One representative blog post — the pillar accelerator article — so the
// blog-prose editorial system gets audited, not just the index.
const BLOG_SLUG = "startup-accelerator-programs-for-high-schoolers";

// Every publicly reachable page (unauthed). /apply is auth-gated and
// redirects to /signup, so the funnel entry we can actually capture is the
// signup form; noted in the report.
const ROUTES = [
  ["home", "/"],
  ["program", "/program"],
  ["sponsors", "/sponsors"],
  ["blog-index", "/blog"],
  ["blog-post", `/blog/${BLOG_SLUG}`],
  ["challenges", "/challenges"],
  ["signup", "/signup"],
  ["login", "/login"],
  ["forgot-password", "/forgot-password"],
  ["terms", "/terms"],
  ["privacy", "/privacy"],
  ["refund-policy", "/refund-policy"],
];

const VIEWPORTS = [
  { tag: "desktop", width: 1440, height: 900, mobile: false },
  { tag: "mobile", width: 390, height: 844, mobile: true },
];

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** Scroll the whole page in steps so lazy/in-view content mounts, then
 *  return to the top and let layout settle before the shot. */
async function primePage(page) {
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    const max = document.body.scrollHeight;
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(600);
}

async function newCtx(browser, vp) {
  return browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    userAgent: vp.mobile ? MOBILE_UA : undefined,
    colorScheme: "dark",
    reducedMotion: "no-preference",
  });
}

const browser = await chromium.launch();
const results = [];

// --- Full-page captures, every route × every viewport ---------------------
for (const [name, path] of ROUTES) {
  for (const vp of VIEWPORTS) {
    const ctx = await newCtx(browser, vp);
    const page = await ctx.newPage();
    try {
      await page.goto(base + path, { waitUntil: "networkidle", timeout: 45000 });
      await primePage(page);
      const file = join(outDir, `${name}-${vp.tag}.png`);
      await page.screenshot({ path: file, fullPage: true });
      results.push(`ok   ${name}-${vp.tag} → ${page.url()}`);
    } catch (e) {
      results.push(`ERR  ${name}-${vp.tag}: ${String(e).slice(0, 120)}`);
    }
    await ctx.close();
  }
}

// --- Interaction states ---------------------------------------------------

// 1. Mobile nav open — tap the hamburger, capture the open sheet.
{
  const ctx = await newCtx(browser, VIEWPORTS[1]);
  const page = await ctx.newPage();
  try {
    await page.goto(base + "/", { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(400);
    const btn = page.getByRole("button", { name: /menu|open/i }).first();
    await btn.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(outDir, "state-mobile-nav-open.png") });
    results.push("ok   state-mobile-nav-open");
  } catch (e) {
    results.push(`ERR  state-mobile-nav-open: ${String(e).slice(0, 120)}`);
  }
  await ctx.close();
}

// 2. FAQ expanded — desktop home, open the first FAQ disclosure.
{
  const ctx = await newCtx(browser, VIEWPORTS[0]);
  const page = await ctx.newPage();
  try {
    await page.goto(base + "/", { waitUntil: "networkidle", timeout: 45000 });
    await primePage(page);
    const faq = page.locator("#faq").first();
    await faq.scrollIntoViewIfNeeded();
    const q = faq.getByRole("button").first();
    await q.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(outDir, "state-faq-expanded.png") });
    results.push("ok   state-faq-expanded");
  } catch (e) {
    results.push(`ERR  state-faq-expanded: ${String(e).slice(0, 120)}`);
  }
  await ctx.close();
}

// 3. Signup form focused — the reachable funnel entry (apply is auth-gated).
{
  const ctx = await newCtx(browser, VIEWPORTS[0]);
  const page = await ctx.newPage();
  try {
    await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(400);
    const input = page.locator("input").first();
    await input.focus();
    await input.type("ada", { delay: 40 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, "state-signup-focused.png") });
    results.push("ok   state-signup-focused");
  } catch (e) {
    results.push(`ERR  state-signup-focused: ${String(e).slice(0, 120)}`);
  }
  await ctx.close();
}

await browser.close();
console.log(results.join("\n"));
console.log(`\ndone → ${outDir}`);
