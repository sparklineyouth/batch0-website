import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_HELP_TEXT,
  DEFAULT_QUIET_HOURS,
  MARKETING_TEXTS_ENABLED,
  SMS_AUDIENCE_SEGMENTS,
  SMS_MIN_AGE,
  canOptInAtAge,
  isPurposeAllowed,
} from "./sms/policy.ts";
import {
  CONSENT_COPY,
  HELP_REPLY,
  OPT_IN_REPLY,
  OPT_OUT_REPLY,
  UNMONITORED_REPLY,
} from "./sms/copy.ts";
import { measureSms } from "./sms/segments.ts";
import { AUDIENCE_SEGMENTS } from "./email/catalog.ts";

// Run with `npm test`.
//
// lib/sms-consent-policy.test.ts locks what the privacy policy promises about
// texts. This file locks the texting feature to those promises: that it can't
// send marketing, that every sentence it shows or sends says what the policy
// says, and that the pieces outside lib/sms/ — the migration, the legal pages,
// the middleware, the cron — are wired the way the feature assumes.
//
// If you are here because a test failed and you are trying to ship marketing
// texts: the fix is docs/sms-marketing-opt-in.md, not this file.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
// JSX wraps prose across source lines; match the sentence a reader sees.
const flat = (src: string) => src.replace(/\{" "\}/g, " ").replace(/&rsquo;/g, "’").replace(/\s+/g, " ");

const migration = read("../supabase/migrations/0106_sms_messaging.sql");

// ---------------------------------------------------------------------------
// No marketing
// ---------------------------------------------------------------------------

test("marketing texts are off, and only program texts are allowed", () => {
  assert.equal(
    MARKETING_TEXTS_ENABLED,
    false,
    "The privacy policy says we do not send promotional or marketing texts. Turning this on needs docs/sms-marketing-opt-in.md done first, then the policy changed.",
  );
  assert.equal(isPurposeAllowed("transactional"), true);
  assert.equal(isPurposeAllowed("promotional"), false);
  assert.equal(isPurposeAllowed("marketing"), false);
});

test("nothing in the app asks for promotional consent", () => {
  // Each place that could write a consent row or a campaign. A literal
  // "promotional" purpose in any of them would be a code path the policy
  // switch doesn't see.
  for (const file of [
    "../app/dashboard/phone/actions.ts",
    "../app/dashboard/phone/phone-form.tsx",
    "../app/admin/sms/blast/actions.ts",
    "../app/admin/sms/blast/blast-form.tsx",
    "../app/admin/sms/consent/actions.ts",
  ]) {
    assert.doesNotMatch(read(file), /purposes?:\s*\[?\s*"promotional"/, file);
  }
});

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

test("the opt-in sentence carries everything a carrier and the policy require", () => {
  const copy = CONSENT_COPY.studentTransactional;
  assert.match(copy, /batch0/, "brand");
  assert.match(copy, /program updates/i, "what the texts are");
  assert.match(copy, /No marketing texts/i, "the policy's promise, in the person's own words");
  assert.match(copy, /frequency varies/i);
  assert.match(copy, /Msg & data rates may apply/);
  assert.match(copy, /Reply STOP/);
  assert.match(copy, /HELP/);
  assert.match(copy, /not a condition/i, "consent can never be a condition of participation");
});

test("the admin's own-phone test sentence is a consent in the first person", () => {
  assert.match(CONSENT_COPY.adminTest, /my own mobile number/);
  assert.match(CONSENT_COPY.adminTest, /STOP/);
  assert.match(CONSENT_COPY.adminTest, /rates may apply/);
});

test("every automatic reply names the brand and fits in one GSM-7 segment", () => {
  // These go out on every keyword and are billed like any other text; a curly
  // quote would triple each one, and nobody reviews them after they ship.
  for (const [name, reply] of Object.entries({ HELP_REPLY, OPT_IN_REPLY, OPT_OUT_REPLY, UNMONITORED_REPLY })) {
    assert.match(reply, /batch0/, name);
    const m = measureSms(reply);
    assert.equal(m.encoding, "GSM-7", `${name}: ${m.nonGsmChars.join(" ")}`);
    assert.equal(m.segments, 1, name);
  }
  assert.match(HELP_REPLY, /STOP/);
  assert.match(HELP_REPLY, /hello@batch0\.org/);
  assert.match(HELP_REPLY, /batch0\.org\/messages/, "the page HELP points at has to be the one we publish");
  assert.match(OPT_OUT_REPLY, /START/, "the opt-out confirmation says how to undo it");
  assert.match(UNMONITORED_REPLY, /STOP/);
});

test("the /messages page says what the privacy policy says", () => {
  const page = flat(read("../app/(legal)/messages/page.tsx"));
  assert.match(page, /We do not send promotional or marketing texts/);
  assert.match(page, /reply <strong>STOP<\/strong>/i);
  assert.match(page, /<strong>START<\/strong>/);
  assert.match(page, /<strong>HELP<\/strong>/);
  assert.match(page, /10 business days/);
  assert.match(page, /please stop texting me/, "a sentence counts, and the page has to say so");
  assert.match(page, /not a condition/i);
  assert.match(page, /under 13/);
  assert.doesNotMatch(page, /parent or guardian number/i, "we don't text parent numbers");
});

test("the terms carry a texting section that matches", () => {
  const terms = flat(read("../app/(legal)/terms/page.tsx"));
  assert.match(terms, /<h2>Text messages<\/h2>/);
  assert.match(terms, /don’t send promotional or marketing texts/);
  assert.match(terms, /not a condition of applying, enrolling, or any purchase/);
  assert.match(terms, /Carriers are not liable/);
});

// ---------------------------------------------------------------------------
// Minors and audiences
// ---------------------------------------------------------------------------

test("under-13s aren't offered texts; an unknown age isn't treated as a child", () => {
  assert.equal(SMS_MIN_AGE, 13);
  assert.equal(canOptInAtAge(12), false);
  assert.equal(canOptInAtAge(10), false);
  assert.equal(canOptInAtAge(13), true);
  assert.equal(canOptInAtAge(17), true);
  assert.equal(canOptInAtAge(null), true);
  assert.equal(canOptInAtAge(undefined), true);
});

test("program texts only go to program audiences, and each one is a real email segment", () => {
  const known = new Set(AUDIENCE_SEGMENTS.map((s) => s.value as string));
  for (const s of SMS_AUDIENCE_SEGMENTS) assert.ok(known.has(s), `${s} is not an email catalog segment`);
  for (const wide of ["everyone", "no_application", "draft", "mentors", "admins"]) {
    assert.ok(!(SMS_AUDIENCE_SEGMENTS as readonly string[]).includes(wide), wide);
  }
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

test("the code's settings defaults are the migration's column defaults", () => {
  assert.match(migration, new RegExp(`quiet_start_hour integer not null default ${DEFAULT_QUIET_HOURS.startHour}\\b`));
  assert.match(migration, new RegExp(`quiet_end_hour integer not null default ${DEFAULT_QUIET_HOURS.endHour}\\b`));
  assert.ok(migration.includes(`'${DEFAULT_HELP_TEXT}'`), "help_text default drifted from DEFAULT_HELP_TEXT");
});

test("0106 leaves every existing table alone and seeds no credentials", () => {
  // The app normalizes applications.phone at read time; the migration must not
  // add a student-writable copy of it, or touch any table it doesn't create.
  assert.doesNotMatch(migration, /alter table public\.applications/i);
  assert.doesNotMatch(migration, /^\s*(update|delete from)\s/im);
  assert.match(migration, /insert into public\.sms_settings \(id\) values \(true\)/);
  assert.doesNotMatch(migration, /auth_token_encrypted\s*=|account_sid\s*=/);
});

// ---------------------------------------------------------------------------
// Wiring outside lib/sms
// ---------------------------------------------------------------------------

test("the webhook skips the session middleware; /messages is public and static", () => {
  assert.match(read("../middleware.ts"), /api\/webhooks\/sms\|/, "the provider's POST carries no session");
  assert.match(read("./supabase/middleware.ts"), /^\s*"\/messages",$/m);
  assert.match(read("../scripts/verify-static.mjs"), /^\s*"\/messages",$/m);
  assert.match(read("../app/sitemap.ts"), /\$\{BASE\}\/messages`/);
  assert.match(read("./app-host.ts"), /^\s*"\/messages",$/m);
  assert.match(read("../components/footer.tsx"), /href="\/messages"/);
});

test("the drain is on the cron, every five minutes", () => {
  const crons = JSON.parse(read("../vercel.json")).crons as { path: string; schedule: string }[];
  assert.deepEqual(
    crons.find((c) => c.path === "/api/cron/sms-queue"),
    { path: "/api/cron/sms-queue", schedule: "*/5 * * * *" },
  );
});
