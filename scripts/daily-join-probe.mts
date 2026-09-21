/**
 * Narrow probe: is `account-missing-payment-method` about our room config, or
 * about the Daily account itself?
 *
 * Joins the plainest possible room — public, no properties, no token, no paid
 * feature requested. If even that can't start a session, nothing in this repo
 * can fix it and the answer is "the account needs a card" (or another
 * provider). Throwaway diagnostic; not wired into package.json.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const KEY = process.env.DAILY_API_KEY!;
const API = "https://api.daily.co/v1";

async function daily<T>(p: string, init: any = { method: "GET" }): Promise<T> {
  const res = await fetch(API + p, {
    method: init.method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`${init.method} ${p} -> ${res.status} ${await res.text()}`);
  return res.json() as any;
}

const bundle = readFileSync("node_modules/@daily-co/daily-js/dist/daily-iframe.js");
const HTML = `<!doctype html><html><body><div id="s" style="width:800px;height:600px"></div>
<script src="/d.js"></script><script>
window.__r=null;
window.__go=async function(url){
  const c=window.DailyIframe.createFrame(document.getElementById("s"),{url});
  try{ await c.join({url}); window.__r={ok:true}; }
  catch(e){ window.__r={ok:false,msg:(e&&(e.errorMsg||e.message))||String(e)}; }
};
</script></body></html>`;

async function main() {
  // The plainest room Daily will make: public, zero properties.
  const room = await daily<{ name: string; url: string }>("/rooms", {
    method: "POST",
    body: { name: `probe-${Date.now().toString(36)}`, privacy: "public" },
  });
  console.log("created bare public room:", room.url);

  const server = createServer((req, res) => {
    if (req.url?.startsWith("/d.js")) {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(bundle);
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(HTML);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;

  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}`);
  await page.waitForFunction("typeof window.__go === 'function'");
  await page.evaluate((u) => (window as any).__go(u), room.url);

  const deadline = Date.now() + 40_000;
  let result: any = null;
  while (Date.now() < deadline && !result) {
    result = await page.evaluate(() => (window as any).__r);
    if (!result) await new Promise((r) => setTimeout(r, 500));
  }
  console.log("join result:", JSON.stringify(result));

  await browser.close();
  server.close();
  await daily(`/rooms/${room.name}`, { method: "DELETE" }).catch(() => {});

  if (result?.ok) {
    console.log("\n=> A bare public room CAN be joined. The failure is our room/token config.");
  } else {
    console.log(`\n=> Even a bare public room cannot be joined: ${result?.msg}`);
    console.log("=> This is an ACCOUNT-level block. No code change in this repo fixes it.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
