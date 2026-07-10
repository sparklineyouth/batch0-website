// Audit screenshotter: every public route at 390/768/1440, full page,
// plus console-error capture. Usage:
//   node scripts/screenshot-audit.mjs <baseUrl> <outDir>
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const base = process.argv[2] ?? "http://localhost:3100";
const outDir = process.argv[3] ?? "docs/audit/before";
mkdirSync(outDir, { recursive: true });

const ROUTES = [
  ["home", "/"],
  ["program", "/program"],
  ["sponsors", "/sponsors"],
  ["login", "/login"],
  ["signup", "/signup"],
  ["forgot-password", "/forgot-password"],
  ["terms", "/terms"],
  ["privacy", "/privacy"],
  ["refund-policy", "/refund-policy"],
  ["apply-redirect", "/apply"], // gated: captures wherever the redirect lands
];
const WIDTHS = [390, 768, 1440];

const browser = await chromium.launch();
const consoleLog = {};

for (const [name, path] of ROUTES) {
  consoleLog[path] = [];
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width, height: width < 500 ? 844 : 900 },
      deviceScaleFactor: 1,
      userAgent:
        width < 500
          ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
          : undefined,
    });
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning")
        consoleLog[path].push(`[${width}px ${m.type()}] ${m.text().slice(0, 300)}`);
    });
    page.on("pageerror", (e) =>
      consoleLog[path].push(`[${width}px pageerror] ${String(e).slice(0, 300)}`),
    );
    try {
      await page.goto(base + path, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(1200); // settle animations/lazy sections
      await page.screenshot({
        path: join(outDir, `${name}-${width}.png`),
        fullPage: true,
      });
      console.log(`ok  ${name} @${width} → ${page.url()}`);
    } catch (e) {
      console.log(`ERR ${name} @${width}: ${String(e).slice(0, 120)}`);
    }
    await ctx.close();
  }
}
writeFileSync(join(outDir, "console-errors.json"), JSON.stringify(consoleLog, null, 2));
await browser.close();
console.log("done");
