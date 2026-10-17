import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// The October 2026 dependency patch, held in place. `npm audit` is not enough
// on its own: the critical Next.js image-optimizer RCE and the React Server
// Components fixes of October 14 were repository advisories that npm's
// database did not list yet when this patch landed, and a rebase that quietly
// restores an older package-lock.json would pass a typecheck and every other
// test. These read the lockfile Vercel installs from (`npm ci`), not a
// laptop's node_modules, so they fail on exactly what would ship.

type LockEntry = { version?: string; dev?: boolean; optional?: boolean };
const lock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
) as { packages: Record<string, LockEntry> };
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  overrides: Record<string, unknown>;
};

// Every installed copy of a package: the top-level one and any nested under
// another dependency's node_modules.
function installed(name: string): { path: string; version: string }[] {
  const suffix = `node_modules/${name}`;
  return Object.entries(lock.packages)
    .filter(([path]) => path === suffix || path.endsWith(`/${suffix}`))
    .map(([path, entry]) => ({ path, version: entry.version ?? "" }));
}

// Plain x.y.z comparison. No dependency here is on a prerelease, and pulling
// in `semver` would make this test rely on whichever copy happens to be
// hoisted, which is the kind of drift it exists to catch.
function cmp(a: string, b: string): number {
  const pa = a.split(/[.+-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
const inRange = (v: string, from: string, below: string) => cmp(v, from) >= 0 && cmp(v, below) < 0;

// name -> the version ranges advisories cover, as [first affected, first fixed).
// Ranges are the published ones, so a copy outside them is either patched or a
// different major line the advisory never touched.
const VULNERABLE: Record<string, { from: string; below: string; advisory: string }[]> = {
  next: [
    // Image Optimization RCE via SVG (critical) and Server Actions CPU DoS
    // (high), fixed in 15.5.28; that bound also covers the two SSG/ISR cache
    // poisoning advisories fixed in 15.5.27.
    {
      from: "10.0.0",
      below: "15.5.28",
      advisory: "GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r, GHSA-4jqv-mc3x-m676, GHSA-mcj8-r9mp-w47p",
    },
    { from: "16.0.0", below: "16.4.1", advisory: "GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r" },
  ],
  // React Server Components RCE (critical) and Server Functions DoS (high).
  // Next's App Router runs its own vendored copy of these, which next 15.5.28
  // carries patched; this keeps a standalone copy from slipping in beside it.
  ...Object.fromEntries(
    ["react-server-dom-webpack", "react-server-dom-turbopack"].map((name) => [
      name,
      [
        ["19.0.0", "19.0.9"],
        ["19.1.0", "19.1.10"],
        ["19.2.0", "19.2.9"],
        ["19.3.0", "19.3.1"],
      ].map(([from, below]) => ({ from, below, advisory: "GHSA-xqc2-xf4c-x3h3, GHSA-h3gv-c5rc-p453" })),
    ]),
  ),
  // librsvg memory bug behind the Next image-optimizer RCE (CVE-2026-96889).
  sharp: [{ from: "0.0.0", below: "0.35.5", advisory: "GHSA-wq5f-xc86-pv6w" }],
  // SMTP sender (lib/email/send.ts): address-parser DoS, malformed envelope
  // recipients, TLS servername reuse across transports.
  nodemailer: [
    { from: "0.0.0", below: "10.0.9", advisory: "GHSA-v53p-9fqp-m79j, GHSA-prgh-xp8r-p3m5, GHSA-g57g-f23g-4646, GHSA-6vj9-mwq6-2f5v, GHSA-8vvx-rff5-p5rq" },
  ],
  postcss: [{ from: "0.0.0", below: "8.5.23", advisory: "GHSA-fxqj-rqcc-2cmp, GHSA-r28c-9q8g-f849" }],
  "source-map-js": [{ from: "1.0.0", below: "1.2.2", advisory: "GHSA-68fv-2mgg-jv7q" }],
  "brace-expansion": [{ from: "4.0.0", below: "5.0.12", advisory: "GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p" }],
  "fast-uri": [{ from: "3.0.0", below: "3.1.8", advisory: "GHSA-hrr3-gc8f-f4qj" }],
  // No sprintf-js release fixes GHSA-hp3w-g68c-fv3c; it only arrives through
  // argparse 1.x, which the js-yaml override below replaces.
  argparse: [{ from: "1.0.0", below: "2.0.0", advisory: "GHSA-hp3w-g68c-fv3c (via sprintf-js)" }],
};

test("the lockfile installs no copy of a package inside a published vulnerable range", () => {
  const hits: string[] = [];
  for (const [name, ranges] of Object.entries(VULNERABLE)) {
    for (const { path, version } of installed(name)) {
      for (const r of ranges) {
        if (inRange(version, r.from, r.below)) hits.push(`${path}@${version} (${r.advisory})`);
      }
    }
  }
  assert.deepEqual(hits, []);
  // A package that vanished from the tree would make the loop above vacuous.
  for (const name of ["next", "react", "react-dom", "sharp", "nodemailer", "postcss"]) {
    assert.ok(installed(name).length > 0, `${name} is no longer in package-lock.json`);
  }
  assert.deepEqual(installed("sprintf-js"), [], "sprintf-js has no patched release");
});

test("package.json asks for the same patched releases the lockfile resolves", () => {
  const top = (name: string) => lock.packages[`node_modules/${name}`]?.version;
  // Exact pins, so `npm install` on a laptop cannot float next or React to a
  // release nobody has built against.
  for (const name of ["next", "@next/third-parties", "react", "react-dom"]) {
    assert.equal(pkg.dependencies[name], top(name), `${name} should be pinned to what is locked`);
  }
  // @next/third-parties ships in lockstep with next; a mismatch means one of
  // them was bumped alone.
  assert.equal(pkg.dependencies["@next/third-parties"], pkg.dependencies.next);
  assert.equal(pkg.dependencies["react-dom"], pkg.dependencies.react);
  // 19.3.1 is the React release carrying the October 14 Server Components
  // fixes. The advisories name react-server-dom-*, not react itself, but the
  // top-level packages stay on the patched release rather than the one before.
  assert.ok(cmp(pkg.dependencies.react, "19.3.1") >= 0, `react ${pkg.dependencies.react} predates 19.3.1`);
  // Next 15.5.28 itself asks for sharp ^0.35.5 (or the unaffected 0.34 line);
  // the direct devDependency must not hold an older copy beside it.
  assert.match(pkg.devDependencies.sharp, /^\^0\.35\.(5|[6-9]|\d{2,})/);
  assert.match(pkg.dependencies.nodemailer, /^\^10\./);
  // nodemailer 10 ships its own declarations; the old DefinitelyTyped package
  // would load beside them as an implicit type library and describe 9.x.
  assert.equal(pkg.devDependencies["@types/nodemailer"], undefined);
});

// The SMTP transport in lib/email/send.ts, exercised on nodemailer 10 without
// a network: the module shape its dynamic import relies on, the exact pool
// options it passes, and a message composed with the fields it sends.
test("nodemailer 10 still gives the SMTP sender what it calls", async () => {
  const nodemailer = await import("nodemailer");
  assert.equal(typeof nodemailer.createTransport, "function");

  // Same options as smtpTransport(); a pool opens no socket until a send.
  const pool = nodemailer.createTransport({
    host: "127.0.0.1",
    port: 587,
    secure: false,
    auth: { user: "sender@example.test", pass: "not-a-real-password" },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
  });
  assert.equal(typeof pool.sendMail, "function");
  assert.equal(typeof pool.verify, "function");
  assert.equal(typeof pool.close, "function");
  pool.close();

  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const info = await stream.sendMail({
    from: "batch0 <hello@example.test>",
    to: ["a@example.test", "b@example.test"],
    subject: "Your application",
    html: "<p>Hi</p>",
    text: "Hi",
    replyTo: "team@example.test",
    headers: { "X-Batch0-Template": "application.accepted" },
  });
  const raw = String(info.message);
  assert.match(raw, /^X-Batch0-Template: application\.accepted$/m);
  assert.match(raw, /^Reply-To: team@example\.test$/m);
  assert.match(raw, /^To: a@example\.test, b@example\.test$/m);
  assert.deepEqual(info.envelope.to, ["a@example.test", "b@example.test"]);
  assert.ok(info.messageId, "sendEmail returns info.messageId as the send's id");
});

// The js-yaml override swaps argparse 1 (and its unpatchable sprintf-js) for
// argparse 2. That is only safe because js-yaml's library never loads argparse
// (its CLI does). If a future gray-matter or js-yaml started loading it while
// parsing, the override would be changing parsing code, and this says so.
test("gray-matter parses blog front matter without loading argparse", () => {
  const require = createRequire(import.meta.url);
  const matter = require("gray-matter") as (src: string) => {
    data: Record<string, unknown>;
    content: string;
  };
  const { data, content } = matter(
    '---\ntitle: "Balance"\ndate: "2026-05-26"\ntags: ["time", "focus"]\n---\n\nBody text.\n',
  );
  assert.deepEqual(data, { title: "Balance", date: "2026-05-26", tags: ["time", "focus"] });
  assert.equal(content.trim(), "Body text.");
  const loaded = Object.keys(require.cache).filter((p) => /[\\/]node_modules[\\/]argparse[\\/]/.test(p));
  assert.deepEqual(loaded, []);
  assert.deepEqual(pkg.overrides["js-yaml"], { argparse: "2.0.1" });
});
