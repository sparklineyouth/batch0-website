import { test } from "node:test";
import assert from "node:assert/strict";
import {
  awardDiscountCents,
  awardRefundCents,
  callCredits,
  canAward,
  canBookCall,
  checkEligibility,
  describeAward,
  formatMoney,
  fulfillmentFor,
  normalizeCents,
  normalizeMentorCalls,
  normalizePercent,
  stageOf,
  MAX_MENTOR_CALLS,
  type ApplicantState,
  type AwardTerms,
  type ScholarshipOffer,
} from "./scholarship-award.ts";

const NOW = new Date("2026-09-15T12:00:00Z");

function terms(over: Partial<AwardTerms> = {}): AwardTerms {
  return {
    awardType: "discount",
    amountCents: 5000,
    percent: null,
    mentorCalls: 0,
    ...over,
  };
}

function offer(over: Partial<ScholarshipOffer> = {}): ScholarshipOffer {
  return {
    name: "Need-based grant",
    enabled: true,
    opensAt: null,
    closesAt: null,
    seats: null,
    awardedCount: 0,
    eligibleStages: ["accepted", "enrolled"],
    ...over,
  };
}

function state(over: Partial<ApplicantState> = {}): ApplicantState {
  return {
    applicationStatus: "accepted",
    enrolled: false,
    liveStatuses: [],
    ...over,
  };
}

// --- normalizers ------------------------------------------------------------

test("normalizeCents floors and rejects nonsense", () => {
  assert.equal(normalizeCents(1250), 1250);
  assert.equal(normalizeCents(12.9), 12);
  assert.equal(normalizeCents(-5), 0);
  assert.equal(normalizeCents("abc"), 0);
  assert.equal(normalizeCents(null), 0);
});

test("normalizePercent clamps to 1..100", () => {
  assert.equal(normalizePercent(50), 50);
  assert.equal(normalizePercent(150), 100);
  assert.equal(normalizePercent(0), null);
  assert.equal(normalizePercent(""), null);
  assert.equal(normalizePercent(null), null);
});

test("normalizeMentorCalls caps the grant", () => {
  assert.equal(normalizeMentorCalls(3), 3);
  assert.equal(normalizeMentorCalls(999), MAX_MENTOR_CALLS);
  assert.equal(normalizeMentorCalls(-1), 0);
});

// --- discount ---------------------------------------------------------------

test("awardDiscountCents applies a flat amount", () => {
  assert.equal(awardDiscountCents(terms({ amountCents: 5000 }), 13000), 5000);
});

test("awardDiscountCents applies a percentage of the price actually billed", () => {
  // 50% of the post-promo, post-founder-pass price — not of US list.
  assert.equal(awardDiscountCents(terms({ percent: 50 }), 10000), 5000);
  assert.equal(awardDiscountCents(terms({ percent: 100 }), 9700), 9700);
});

test("awardDiscountCents prefers percent when both are set", () => {
  const t = terms({ amountCents: 9999, percent: 10 });
  assert.equal(awardDiscountCents(t, 10000), 1000);
});

test("awardDiscountCents never exceeds what the student owes", () => {
  // A $200 award against a $130 balance is a $130 award, not a $70 payout.
  assert.equal(awardDiscountCents(terms({ amountCents: 20000 }), 13000), 13000);
});

test("awardDiscountCents is zero once the balance is already zero", () => {
  // Full-ride founder pass + a scholarship must not go negative.
  assert.equal(awardDiscountCents(terms({ percent: 50 }), 0), 0);
  assert.equal(awardDiscountCents(terms({ amountCents: 5000 }), 0), 0);
});

test("awardDiscountCents is zero for a calls-only award", () => {
  const t = terms({ awardType: "mentor_calls", mentorCalls: 3, amountCents: 5000 });
  assert.equal(awardDiscountCents(t, 13000), 0);
});

// --- refund -----------------------------------------------------------------

test("awardRefundCents is bounded by what was actually paid", () => {
  // Paid $97 in a sale, later given a "full tuition" scholarship: $97 back,
  // not today's $130 headline.
  assert.equal(awardRefundCents(terms({ percent: 100 }), 9700), 9700);
  assert.equal(awardRefundCents(terms({ amountCents: 13000 }), 9700), 9700);
});

test("awardRefundCents subtracts what has already gone back", () => {
  assert.equal(awardRefundCents(terms({ amountCents: 5000 }), 13000, 10000), 3000);
  assert.equal(awardRefundCents(terms({ amountCents: 5000 }), 13000, 13000), 0);
});

test("awardRefundCents is zero when nothing was paid", () => {
  assert.equal(awardRefundCents(terms({ percent: 50 }), 0), 0);
});

test("awardRefundCents is zero for a calls-only award", () => {
  const t = terms({ awardType: "mentor_calls", mentorCalls: 3 });
  assert.equal(awardRefundCents(t, 13000), 0);
});

// --- fulfillment ------------------------------------------------------------

test("fulfillmentFor routes money by whether they've paid", () => {
  assert.equal(fulfillmentFor(terms(), { hasPaid: false }), "discount");
  assert.equal(fulfillmentFor(terms(), { hasPaid: true }), "refund_due");
  assert.equal(
    fulfillmentFor(terms(), { hasPaid: true, refundedCents: 5000 }),
    "refunded",
  );
});

test("fulfillmentFor leaves a calls award alone", () => {
  const t = terms({ awardType: "mentor_calls", mentorCalls: 3 });
  assert.equal(fulfillmentFor(t, { hasPaid: true }), "none");
  assert.equal(fulfillmentFor(t, { hasPaid: false }), "none");
});

// --- display ----------------------------------------------------------------

test("formatMoney drops cents on whole dollars", () => {
  assert.equal(formatMoney(13000), "$130");
  assert.equal(formatMoney(1250), "$12.50");
  assert.equal(formatMoney(0), "$0");
});

test("describeAward reads naturally", () => {
  assert.equal(describeAward(terms({ amountCents: 5000 })), "$50 off tuition");
  assert.equal(describeAward(terms({ percent: 50 })), "50% off tuition");
  assert.equal(
    describeAward(terms({ awardType: "mentor_calls", mentorCalls: 3 })),
    "3 extra mentor calls",
  );
  assert.equal(
    describeAward(terms({ awardType: "mentor_calls", mentorCalls: 1 })),
    "1 extra mentor call",
  );
});

// --- stage ------------------------------------------------------------------

test("stageOf reads enrolment first so the two sources can't disagree", () => {
  assert.equal(stageOf(state({ enrolled: true, applicationStatus: "accepted" })), "enrolled");
  assert.equal(stageOf(state({ applicationStatus: "paid" })), "enrolled");
  assert.equal(stageOf(state({ applicationStatus: "enrolled" })), "enrolled");
  assert.equal(stageOf(state({ applicationStatus: "accepted" })), "accepted");
});

test("stageOf refuses everyone who isn't accepted yet", () => {
  for (const s of ["draft", "submitted", "waitlisted", "rejected", "withdrawn", null]) {
    assert.equal(stageOf(state({ applicationStatus: s })), null, String(s));
  }
});

// --- eligibility ------------------------------------------------------------

test("checkEligibility passes an accepted student on an open scholarship", () => {
  const out = checkEligibility(offer(), state(), NOW);
  assert.deepEqual(out, { ok: true, stage: "accepted" });
});

test("checkEligibility passes an enrolled student — awards work after enrollment", () => {
  const out = checkEligibility(
    offer(),
    state({ enrolled: true, applicationStatus: "enrolled" }),
    NOW,
  );
  assert.deepEqual(out, { ok: true, stage: "enrolled" });
});

test("checkEligibility respects the open/close window", () => {
  const early = checkEligibility(
    offer({ opensAt: "2026-10-01T00:00:00Z" }),
    state(),
    NOW,
  );
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.reason, "closed");

  const late = checkEligibility(
    offer({ closesAt: "2026-09-01T00:00:00Z" }),
    state(),
    NOW,
  );
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.reason, "closed");

  const inWindow = checkEligibility(
    offer({ opensAt: "2026-09-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" }),
    state(),
    NOW,
  );
  assert.equal(inWindow.ok, true);
});

test("checkEligibility ignores an unparseable date rather than locking everyone out", () => {
  const out = checkEligibility(offer({ closesAt: "not a date" }), state(), NOW);
  assert.equal(out.ok, true);
});

test("checkEligibility closes when seats run out", () => {
  const out = checkEligibility(offer({ seats: 3, awardedCount: 3 }), state(), NOW);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "full");

  const open = checkEligibility(offer({ seats: 3, awardedCount: 2 }), state(), NOW);
  assert.equal(open.ok, true);
});

test("checkEligibility enforces the stage the scholarship is scoped to", () => {
  const enrolledOnly = offer({ eligibleStages: ["enrolled"] });
  const out = checkEligibility(enrolledOnly, state({ applicationStatus: "accepted" }), NOW);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, "stage");
    assert.match(out.message, /once you've enrolled/);
  }
});

test("checkEligibility turns away an applicant who isn't accepted yet", () => {
  const out = checkEligibility(offer(), state({ applicationStatus: "submitted" }), NOW);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, "stage");
    assert.match(out.message, /once you've been accepted/);
  }
});

test("checkEligibility enforces one scholarship per student", () => {
  const out = checkEligibility(offer(), state({ liveStatuses: ["awarded"] }), NOW);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, "holds_award");
    assert.match(out.message, /only one per student/);
  }
});

test("checkEligibility blocks queueing up a second application while one is pending", () => {
  // Otherwise a student could apply to all five and take whichever lands, and
  // the per-scholarship seat counts would stop meaning anything.
  const out = checkEligibility(offer(), state({ liveStatuses: ["submitted"] }), NOW);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.message, /under review/);
});

test("checkEligibility explains an existing award before saying already-applied", () => {
  // A student holding an award elsewhere must not be told "you already applied"
  // about a scholarship they never touched.
  const out = checkEligibility(
    offer(),
    state({ liveStatuses: ["awarded"] }),
    NOW,
    { alreadyAppliedHere: true },
  );
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "holds_award");
});

test("checkEligibility reports a repeat application to the same scholarship", () => {
  const out = checkEligibility(offer(), state(), NOW, { alreadyAppliedHere: true });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "already_applied");
});

test("checkEligibility ignores a declined or withdrawn past attempt", () => {
  const out = checkEligibility(
    offer(),
    state({ liveStatuses: [] }),
    NOW,
  );
  assert.equal(out.ok, true);
});

// --- admin-side award guard -------------------------------------------------

test("canAward accepts a submitted application", () => {
  assert.deepEqual(
    canAward({ status: "submitted", otherLiveStatuses: [], seats: null, awardedCount: 0 }),
    { ok: true },
  );
});

test("canAward refuses the wrong statuses", () => {
  for (const status of ["awarded", "withdrawn", "draft"] as const) {
    const out = canAward({ status, otherLiveStatuses: [], seats: null, awardedCount: 0 });
    assert.equal(out.ok, false, status);
  }
});

test("canAward re-checks one-at-a-time at decision time", () => {
  // The student's situation can change between applying and being reviewed.
  const out = canAward({
    status: "submitted",
    otherLiveStatuses: ["awarded"],
    seats: null,
    awardedCount: 0,
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /already holds another scholarship/);
});

test("canAward refuses to oversubscribe the seats", () => {
  const out = canAward({
    status: "submitted",
    otherLiveStatuses: [],
    seats: 2,
    awardedCount: 2,
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /Add a seat/);
});

// --- mentor-call credits ----------------------------------------------------

test("callCredits computes the remaining balance", () => {
  assert.deepEqual(callCredits(3, 1), { granted: 3, used: 1, remaining: 2 });
  assert.deepEqual(callCredits(3, 0), { granted: 3, used: 0, remaining: 3 });
});

test("callCredits clamps used so remaining never goes negative", () => {
  // An admin can lower a grant after calls were already booked.
  assert.deepEqual(callCredits(2, 5), { granted: 2, used: 2, remaining: 0 });
  assert.deepEqual(callCredits(0, 3), { granted: 0, used: 0, remaining: 0 });
});

test("canBookCall gates on the remaining balance", () => {
  assert.equal(canBookCall(callCredits(3, 2)), true);
  assert.equal(canBookCall(callCredits(3, 3)), false);
  assert.equal(canBookCall(callCredits(0, 0)), false);
});
