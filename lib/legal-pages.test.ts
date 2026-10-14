import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The legal pages describe the product as it is. These checks catch the two
// ways they have drifted before: naming features that were removed as if
// they still ran, and saying nothing about something the product does by
// default (recording calls and webinars, many of them with students under 18).

// JSX wraps prose across source lines; match the sentence a reader sees.
function flat(src: string): string {
  return src.replace(/\{" "\}/g, " ").replace(/\s+/g, " ");
}

const PAGES = ["privacy", "refund-policy", "terms"] as const;
const page = (name: (typeof PAGES)[number]) =>
  flat(readFileSync(new URL(`../app/(legal)/${name}/page.tsx`, import.meta.url), "utf8"));

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

test("each legal page's 'Last updated' line matches its structured dateModified", () => {
  for (const name of PAGES) {
    const src = page(name);
    const shown = src.match(/Last updated: (\w+) (\d{1,2}), (\d{4})/);
    const data = src.match(/dateModified: "(\d{4})-(\d{2})-(\d{2})"/);
    assert.ok(shown, `${name}: no "Last updated" line`);
    assert.ok(data, `${name}: no dateModified`);
    const [, month, day, year] = shown;
    assert.equal(
      `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, "0")}-${day.padStart(2, "0")}`,
      `${data[1]}-${data[2]}-${data[3]}`,
      name,
    );
  }
});

test("no legal page names a removed feature as a current one", () => {
  // Retired in October 2026: Discord replaced discussions, the team thread,
  // lesson comments and direct messages; Assignments replaced weekly
  // check-ins; 1:1 calls replaced office hours.
  const retired = [
    /team threads?/i,
    /lesson comments?/i,
    /direct messages? in batch0/i,
    /\bdiscussions\b/i,
    /check-ins?\b/i,
    /office hours/i,
  ];
  for (const name of PAGES) {
    const src = page(name);
    for (const phrase of retired) {
      assert.doesNotMatch(src, phrase, `${name} still mentions ${phrase}`);
    }
  }
});

test("the privacy policy says calls and webinars may be recorded, and who can watch", () => {
  const privacy = page("privacy");
  assert.match(privacy, /1:1 calls and webinars may be recorded/);
  assert.match(privacy, /video and audio/);
  assert.match(privacy, /The room shows when it is recording/);
  // lib/recording-sessions.ts viewAccess: a call's people and admins; a
  // webinar's event staff, and its audience once the follow-up shared it.
  assert.match(privacy, /people on that call and by batch0 administrators/);
  assert.match(privacy, /staff who run events and, after the webinar, by the people it was open to/);
});
