import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Run with `npm test`. Pages retired in October 2026 are forwarded by
// next.config.js redirects() so an old bell, email or bookmark lands on the
// section that replaced them instead of a 404. /admin/messages — the DM report
// queue, last seen in the error log as "[action:reportDm] Tell us what's wrong
// so we can act on it." — went with DMs; this keeps its forward, and every
// other one, pointed at a page that exists.

const require = createRequire(import.meta.url);
delete process.env.NEXT_PUBLIC_SENTRY_DSN;
delete process.env.SENTRY_DSN;
const config = require("../next.config.js");
// The matcher Next itself uses for `source`.
const { match } = require("next/dist/compiled/path-to-regexp");

type Redirect = { source: string; destination: string; has?: unknown };
const redirects: Redirect[] = (await config.redirects()).filter((r: Redirect) => !r.has);

/** Where `pathname` is sent, or null when no host-independent redirect matches it. */
function forward(pathname: string): string | null {
  for (const r of redirects) {
    const m = match(r.source, { decode: decodeURIComponent })(pathname);
    if (m) {
      return r.destination.replace(/:(\w+)\*?/g, (_: string, k: string) => {
        const v = (m.params as Record<string, string | string[]>)[k];
        return Array.isArray(v) ? v.join("/") : (v ?? "");
      });
    }
  }
  return null;
}

const APP = fileURLToPath(new URL("../app/", import.meta.url));

test("the old DM-report queue forwards to Support, with or without a report id", () => {
  assert.equal(forward("/admin/messages"), "/admin/support");
  assert.equal(forward("/admin/messages/5b1e2f0a-8c7d-4e6f-9a0b-1c2d3e4f5a6b"), "/admin/support");
  assert.equal(existsSync(`${APP}admin/messages`), false, "nothing renders there any more");
});

test("every retired admin and dashboard page forwards to a page that exists", () => {
  for (const r of redirects) {
    const dest = r.destination.split("?")[0];
    if (!/^\/(admin|dashboard)(\/|$)/.test(dest) || dest.includes(":")) continue;
    assert.ok(
      existsSync(`${APP}${dest.slice(1)}/page.tsx`),
      `${r.source} forwards to ${dest}, which has no page`,
    );
  }
});
