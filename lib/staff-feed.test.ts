import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as feed from "./staff-feed.ts";
import {
  acceptedLine,
  applicationLine,
  challengeEntryLine,
  chargeRefundedLine,
  enrolledLine,
  feedName,
  feedbackCreditLine,
  paymentRefundedLine,
  rebuildLine,
} from "./staff-feed.ts";

const SITE = "https://batch0.test";
const ID = "00000000-0000-4000-8000-000000000001";

test("the feed names a person, or falls back; never by their email", () => {
  assert.equal(feedName("Ada Lovelace", "a student"), "Ada Lovelace");
  assert.equal(feedName("  Ada  ", "a student"), "Ada");
  // profiles.full_name defaults to '' (0001): `??` alone printed "****".
  assert.equal(feedName("", "a student"), "a student");
  assert.equal(feedName("   ", "a student"), "a student");
  assert.equal(feedName(null, "an applicant"), "an applicant");
  assert.equal(feedName(undefined, "an entrant"), "an entrant");
  assert.equal(feedName("ada@example.com", "a student"), "a student");
});

test("each line says who and what happened, and links to its admin page", () => {
  assert.equal(
    applicationLine({ name: "Ada", applicationId: ID, autoAdmitted: false, siteUrl: SITE }),
    `New application: **Ada** · ${SITE}/admin/applications/${ID}`,
  );
  assert.equal(
    applicationLine({ name: null, applicationId: ID, autoAdmitted: true, siteUrl: SITE }),
    `Auto-admitted by founder pass: **an applicant** · ${SITE}/admin/applications/${ID}`,
  );
  assert.equal(
    acceptedLine({ name: "Ada", cohortName: "Fall 2026", applicationId: ID, siteUrl: SITE }),
    `Accepted: **Ada** into Fall 2026 · ${SITE}/admin/applications/${ID}`,
  );
  assert.equal(
    enrolledLine({ name: "", cohortName: "Fall 2026", userId: ID, siteUrl: SITE }),
    `Enrolled: **a student** in Fall 2026 · ${SITE}/admin/students/${ID}`,
  );
  assert.equal(
    chargeRefundedLine({ name: "Ada", kind: "fine", userId: ID, siteUrl: SITE }),
    `Fine refunded to **Ada** · ${SITE}/admin/charges?user=${ID}`,
  );
  assert.equal(
    chargeRefundedLine({ name: "Ada", kind: "fee", userId: ID, siteUrl: SITE }),
    `Fee refunded to **Ada** · ${SITE}/admin/charges?user=${ID}`,
  );
  assert.equal(
    paymentRefundedLine({ name: "Ada", siteUrl: SITE }),
    `Enrollment payment refunded to **Ada** · ${SITE}/admin/payments`,
  );
  assert.equal(
    paymentRefundedLine({ name: null, partial: true, siteUrl: SITE }),
    `Enrollment payment partly refunded to **a student** · ${SITE}/admin/payments`,
  );
  assert.equal(
    feedbackCreditLine({ name: null, topic: "your deck", siteUrl: SITE }),
    `Feedback credit redeemed by **a pass holder** on your deck · ${SITE}/admin/passes#requests`,
  );
  assert.equal(
    rebuildLine({ name: "Ada", siteUrl: SITE }),
    `Seven-day rebuild submitted by **Ada**: queued for one fresh review · ${SITE}/admin/applications`,
  );
  assert.equal(
    challengeEntryLine({ name: "", challengeTitle: "Build Week", challengeId: "c1", submissionId: "s1", siteUrl: SITE }),
    `🏆 New **Build Week** submission from an entrant · ${SITE}/admin/challenges/c1/submissions/s1`,
  );
});

// #staff is read by chat.manage holders, who needn't hold applications.view,
// payments.view or charges.manage. Every caller goes through a builder above,
// so a raw string can't bring an email, an amount or a refund reason back.
// (Enrollment refunds, whichever page or the Stripe dashboard issued them, are
// posted by lib/stripe-fulfillment.ts handleChargeRefunded: see
// lib/stripe-staff-feed.test.ts.)
const CALLERS = [
  "../app/apply/actions.ts",
  "../lib/admissions.ts",
  "../lib/stripe-fulfillment.ts",
  "../app/admin/charges/actions.ts",
  "../app/pass/actions.ts",
  "../app/challenges/[slug]/actions.ts",
];

test("every #staff line is built by lib/staff-feed.ts", () => {
  const builders = new Set(Object.keys(feed).filter((k) => k.endsWith("Line")));
  for (const file of CALLERS) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const heads = [...src.matchAll(/postStaffFeed\(\s*([^\s(]+)/g)].map((m) => m[1]);
    assert.ok(heads.length > 0, `${file} no longer posts to #staff; drop it from CALLERS`);
    for (const head of heads) {
      assert.ok(builders.has(head), `${file}: postStaffFeed(${head}…) isn't a lib/staff-feed.ts line`);
    }
  }
});

// The two admin refund pages go through handleChargeRefunded, which posts the
// line on the recorded transition. A post of their own would be a second line
// for the same refund.
test("an admin refund of an enrollment payment posts no line of its own", () => {
  for (const file of ["../app/admin/payments/actions.ts", "../app/admin/students/[id]/actions.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(/handleChargeRefunded\(/.test(src), `${file} no longer records its refund through handleChargeRefunded`);
    assert.ok(!/postStaffFeed\(/.test(src), `${file} posts to #staff itself`);
  }
});
