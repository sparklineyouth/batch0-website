import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isMarketingPath } from "./app-host.ts";

// Every page under app/(legal) is static legal text: on the app subdomain it
// redirects to batch0.org like the rest of the marketing site, and the
// middleware skips session work for it (lib/supabase/middleware.ts,
// PUBLIC_STATIC_PREFIXES). Listing the folder keeps a new legal page from
// being missed in one of the two lists, as /community-guidelines once was.
const legalDir = new URL("../app/(legal)/", import.meta.url);
const LEGAL = readdirSync(legalDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `/${entry.name}`);

test("the legal pages are found", () => {
  for (const p of ["/privacy", "/terms", "/refund-policy", "/community-guidelines"]) {
    assert.ok(LEGAL.includes(p), `${p} is no longer under app/(legal)`);
  }
});

test("every legal page leaves the app subdomain for batch0.org", () => {
  for (const p of LEGAL) {
    assert.equal(isMarketingPath(p), true, p);
    assert.equal(isMarketingPath(`${p}/`), true, `${p}/`);
  }
  assert.equal(isMarketingPath("/community"), false, "a prefix match is whole segments only");
  assert.equal(isMarketingPath("/chat"), false);
});

test("every legal page skips the middleware's session work", () => {
  const src = readFileSync(new URL("./supabase/middleware.ts", import.meta.url), "utf8");
  const block = src.match(/const PUBLIC_STATIC_PREFIXES = \[([\s\S]*?)\];/);
  assert.ok(block, "PUBLIC_STATIC_PREFIXES moved");
  const listed = new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  for (const p of LEGAL) assert.ok(listed.has(p), `${p} isn't in PUBLIC_STATIC_PREFIXES`);
});
