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

// "messages" is the texting page HELP replies link to (app/(legal)/messages).
const PAGES = ["privacy", "refund-policy", "terms", "community-guidelines", "messages"] as const;
const page = (name: (typeof PAGES)[number]) =>
  flat(readFileSync(new URL(`../app/(legal)/${name}/page.tsx`, import.meta.url), "utf8"));
const faq = () => flat(readFileSync(new URL("../components/faq.tsx", import.meta.url), "utf8"));

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

// Retired in October 2026: discussions, the team thread and lesson comments
// went (batch0 Chat, migration 0101, brought direct messages back and put the
// team thread's history in each team's channel); Assignments replaced weekly
// check-ins; 1:1 calls replaced office hours; Google Drive replaced uploads.
const RETIRED = [
  /team threads?/i,
  /lesson comments?/i,
  /\bdiscussions\b/i,
  /check-ins?\b/i,
  /office hours/i,
];

// The one place a legal page may name them: the privacy policy's list item
// saying their data is still held (0093, 0094, 0097 and 0099 keep the rows).
const RETAINED_ITEM = /<li> <strong>Retired features:<\/strong>(.*?)<\/li>/;

test("no legal page names a removed feature as a current one", () => {
  for (const name of PAGES) {
    const src = page(name).replace(RETAINED_ITEM, "");
    for (const phrase of RETIRED) {
      assert.doesNotMatch(src, phrase, `${name} still mentions ${phrase}`);
    }
  }
});

test("the privacy policy says what it still holds from retired features", () => {
  // Parents are promised they can see and delete "what we hold"; the policy
  // has to name it even though the features are gone.
  const item = page("privacy").match(RETAINED_ITEM)?.[1];
  assert.ok(item, "privacy: no 'Retired features' item");
  assert.match(item, /we still hold/);
  assert.match(item, /since retired/);
  for (const phrase of RETIRED) assert.match(item, phrase);
  assert.match(item, /recap notes/);
  assert.match(item, /files uploaded to batch0/);
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

test("the privacy policy says who can read chat, and that reports and edits change it", () => {
  const privacy = page("privacy");
  assert.match(privacy, /<strong>batch0 Chat:<\/strong>/);
  // 0101 chat_can_read / lib/chat-access.ts canReadChannel, one audience at a
  // time. 'everyone': chat_is_vetted, so every non-student account too.
  assert.match(privacy, /#announcements, #general, #wins and #help: every accepted or enrolled student, and every mentor, investor and other account that isn&rsquo;t a student/);
  assert.match(privacy, /Anyone who can read them can see who else can, by name/);
  // Cohort and team channels open to mentors assigned (mentor_assignments)
  // to anyone in them.
  assert.match(privacy, /Your cohort&rsquo;s channel: your cohort&rsquo;s enrolled students, and the mentors assigned to any of them/);
  assert.match(privacy, /Your team&rsquo;s channel: your team, and the mentors assigned to anyone on it/);
  // Staff read every text channel and addChannelMembers takes anyone.
  assert.match(privacy, /The batch0 team reads every channel, and can add people to any channel/);
  // A DM or group: its members, and staff not party to it once reported.
  assert.match(privacy, /can be read only by the people in it, until one of them reports a message/);
  // conversationAllowed(): staff DMs with students are allowed; non-staff
  // adults only with a staff member in the group.
  assert.match(privacy, /Students can message each other, and the batch0 team, privately/);
  assert.match(privacy, /adults outside the batch0 team can&rsquo;t message students privately/);
  assert.match(privacy, /we keep the earlier version/);
  // lib/chat-purge.ts, called before the auth delete.
  // purgeChatContentFor (lib/chat-purge.ts): Chat copies blanked, old DMs deleted, evidence kept.
  assert.match(privacy, /When an account is deleted, we blank the messages it posted in Chat and delete their earlier versions and files, and we delete its direct messages and team-thread posts from before Chat, except a message someone reported, or any message in a direct or group conversation someone reported: those we keep, with their earlier versions and files, as evidence/);
  // Mentors and investors read the community channels, so they see more
  // than what a student chooses to publish.
  assert.doesNotMatch(privacy, /only see what you choose to publish/);
});

test("the FAQ promises only the safeguarding Chat enforces, and links the guidelines", () => {
  const src = faq();
  // Staff can hold a private DM with a student (only a report opens it), so
  // "no unmonitored private channels between students and adults" was false.
  assert.doesNotMatch(src, /no unmonitored private channels/);
  assert.match(src, /adults outside the batch0 team can't message students privately/);
  assert.match(src, /Students can message each other, and the batch0 team, privately/);
  // Guidelines are published, so the promise has somewhere to point.
  assert.match(src, /published community guidelines/);
  assert.match(src, /href: "\/community-guidelines"/);
  // 0099 retired the community feed.
  assert.doesNotMatch(src, /community feed/);
});

test("the community guidelines say how to report, block and reach a person", () => {
  const g = page("community-guidelines");
  assert.match(g, /choose Report message in its menu/);
  assert.match(g, /never to the person it&rsquo;s about, even when that is someone on the team/);
  // …and when the whole team is part of it, nobody on it is shown it (outsideReportAdvice).
  assert.match(g, /handles reports is part of what you reported, none of them is shown/);
  assert.match(g, /<strong>Block someone<\/strong>/);
  assert.match(g, /href="\/support\?topic=concern"/);
  assert.match(g, /Mentors, investors and other adults outside the batch0 team don&rsquo;t message students privately/);
  // The terms point here, and here back at the terms.
  assert.match(page("terms"), /href="\/community-guidelines"/);
  assert.match(g, /href="\/terms"/);
});
