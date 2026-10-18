import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run with `npm test`. events.zoom_url and events.recording_url hold whatever
// was ever written to them, and an href runs a `javascript:` value in the
// reader's session. The student home always read them through httpsUrl
// (lib/event-form.ts); the installed app's Join button, the recording links,
// the admin event pages, the calendar file and the Demo Day ticket used them
// raw. These pages are React and route code, so what's pinned here is that
// each reads the column through httpsUrl (the function itself is tested in
// lib/event-form.test.ts).

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("every reader of an event link goes through httpsUrl", () => {
  const readers: [file: string, must: RegExp, mustNot?: RegExp][] = [
    ["app/app/(student)/events/page.tsx", /joinUrl: httpsUrl\(e\.zoom_url\)/, /href=\{e\.zoom_url\}/],
    ["components/live/event-card.tsx", /httpsUrl\(event\.externalUrl\)[\s\S]*httpsUrl\(event\.recordingUrl\)/, /href=\{event\.(recordingUrl|externalUrl)\}/],
    ["app/admin/events/[id]/page.tsx", /httpsUrl\(ev\.recording_url\)/, /href=\{ev\.recording_url\}/],
    ["app/admin/events/events-admin.tsx", /httpsUrl\(r\.externalUrl\)/, /href=\{r\.externalUrl\}/],
    // The room page's "Watch the recording" reads LiveAccessEvent.recordingUrl.
    ["lib/live-access.ts", /recordingUrl: httpsUrl\(row\.recording_url\)/],
    // The ticket page's href and both ticket emails' href="…".
    ["lib/demo-day-tickets.ts", /externalUrl: isHostedOnBatch0\(ev\.live_mode\) \? null : httpsUrl\(ev\.zoom_url\)/],
    ["app/api/events/[id]/ics/route.ts", /: httpsUrl\(ev\.zoom_url\)/],
    ["lib/event-history.ts", /httpsUrl\(e\.recording_url\)/],
    ["lib/needs-you.ts", /httpsUrl\(e\.zoom_url\)/],
  ];
  for (const [file, must, mustNot] of readers) {
    const src = read(file);
    assert.match(src, must, file);
    if (mustNot) assert.doesNotMatch(src, mustNot, file);
  }
});

test("no page puts a raw event link column in an href", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(path.join(root, dir))) {
      const rel = path.join(dir, name);
      if (statSync(path.join(root, rel)).isDirectory()) walk(rel);
      else if (/\.tsx$/.test(name) && /href=\{\s*[\w.?]*\b(zoom_url|recording_url)\s*\}/.test(read(rel))) offenders.push(rel);
    }
  };
  walk("app");
  walk("components");
  assert.deepEqual(offenders, []);
});
