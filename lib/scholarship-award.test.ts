import { test } from "node:test";
import assert from "node:assert/strict";
import {
  awardDiscountCents,
  awardRefundCents,
  awardTypeOf,
  callCredits,
  canAward,
  canBookCall,
  checkEligibility,
  describeAward,
  describeMoney,
  formatMoney,
  fulfillmentFor,
  hasAnyPerk,
  hasMoney,
  liveStatusesInCohort,
  normalizeCents,
  normalizeMentorCalls,
  normalizePercent,
  normalizePerks,
  perkAiAllowanceMultiplier,
  perkSummaries,
  stageOf,
  AI_BOOST_MULTIPLIER,
  AWARD_PERK_DEFS,
  MAX_DEMO_DAY_TICKETS,
  MAX_FEEDBACK_CREDITS,
  MAX_MENTOR_CALLS,
  NO_PERKS,
  type ApplicantState,
  type AwardPerks,
  type AwardTerms,
  type ScholarshipOffer,
} from "./scholarship-award.ts";
import { NO_COHORT_REASON, type ScholarshipCohort } from "./scholarship-window.ts";

const NOW = new Date("2026-09-15T12:00:00Z");

/** Fall 2026 as it stands in production: running, late entry through Sep 30 Eastern. */
const FALL: ScholarshipCohort = {
  id: "fall",
  name: "Fall 2026",
  status: "active",
  starts_on: "2026-09-14",
  ends_on: "2026-11-13",
  applications_close_at: "2026-10-01T03:59:59.999Z",
  late_entry_until: "2026-10-01T03:59:59.999Z",
  catch_up_plan: "Complete the Week 1 field guide, then catch-up with the team.",
};

function perks(over: Partial<AwardPerks> = {}): AwardPerks {
  return { ...NO_PERKS, ...over };
}

/** Money terms by default; pass `amountCents: 0` for a perks-only award. */
function terms(over: Partial<AwardTerms> = {}): AwardTerms {
  return {
    amountCents: 5000,
    percent: null,
    perks: NO_PERKS,
    ...over,
  };
}

/** The old "mentor_calls" award: no money, N calls. */
function callsOnly(n: number): AwardTerms {
  return terms({ amountCents: 0, perks: perks({ mentorCalls: n }) });
}

function offer(over: Partial<ScholarshipOffer> = {}): ScholarshipOffer {
  return {
    name: "Need-based grant",
    enabled: true,
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
    cohort: FALL,
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

test("awardDiscountCents is zero for a perks-only award", () => {
  assert.equal(awardDiscountCents(callsOnly(3), 13000), 0);
  assert.equal(
    awardDiscountCents(terms({ amountCents: 0, perks: perks({ aiBoost: true }) }), 13000),
    0,
  );
});

test("money and perks stack: the discount is unchanged by the perks beside it", () => {
  const both = terms({ amountCents: 5000, perks: perks({ mentorCalls: 3, aiBoost: true }) });
  assert.equal(awardDiscountCents(both, 13000), 5000);
  assert.equal(awardRefundCents(both, 13000), 5000);
  assert.equal(fulfillmentFor(both, { hasPaid: false }), "discount");
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

test("awardRefundCents is zero for a perks-only award", () => {
  assert.equal(awardRefundCents(callsOnly(3), 13000), 0);
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

test("fulfillmentFor leaves a perks-only award alone", () => {
  const t = callsOnly(3);
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
  assert.equal(describeAward(callsOnly(3)), "3 extra mentor calls");
  assert.equal(describeAward(callsOnly(1)), "1 extra mentor call");
});

test("describeAward lists money first, then every perk, in roster order", () => {
  const t = terms({
    amountCents: 5000,
    perks: perks({ mentorCalls: 2, feedbackCredits: 1, demoDayTickets: 3, aiBoost: true }),
  });
  assert.equal(
    describeAward(t),
    "$50 off tuition · 2 extra mentor calls · 1 feedback credit · 3 Demo Day guest tickets · AI co-founder boost",
  );
  // Perks only: no money phrase, no leading separator.
  assert.equal(
    describeAward(terms({ amountCents: 0, perks: perks({ feedbackCredits: 2, aiBoost: true }) })),
    "2 feedback credits · AI co-founder boost",
  );
  assert.equal(describeMoney(callsOnly(1)), null);
  assert.equal(describeMoney(terms({ percent: 25 })), "25% off tuition");
});

// --- perks (0074) ------------------------------------------------------------

test("every perk in the roster has a field on AwardPerks and a ceiling the DB agrees with", () => {
  for (const d of AWARD_PERK_DEFS) {
    assert.ok(d.key in NO_PERKS, `${d.key} has no field on AwardPerks`);
    assert.ok(d.label.length > 0);
    assert.ok(d.blurb.length > 0);
    if (d.kind === "count") {
      assert.ok(d.max >= 1);
      assert.ok(d.unit.length > 0);
    }
  }
  // Keep in lockstep with the check constraints in 0071/0074.
  const maxOf = (key: string) => {
    const d = AWARD_PERK_DEFS.find((p) => p.key === key);
    return d && d.kind === "count" ? d.max : -1;
  };
  assert.equal(maxOf("mentorCalls"), MAX_MENTOR_CALLS);
  assert.equal(maxOf("feedbackCredits"), MAX_FEEDBACK_CREDITS);
  assert.equal(maxOf("demoDayTickets"), MAX_DEMO_DAY_TICKETS);
  assert.equal(MAX_MENTOR_CALLS, 20);
  assert.equal(MAX_FEEDBACK_CREDITS, 10);
  assert.equal(MAX_DEMO_DAY_TICKETS, 10);
});

test("normalizePerks clamps to the ceilings and never over-grants on junk", () => {
  assert.deepEqual(normalizePerks(null), NO_PERKS);
  assert.deepEqual(normalizePerks(undefined), NO_PERKS);
  assert.deepEqual(normalizePerks({}), NO_PERKS);
  // A row read straight off the database.
  assert.deepEqual(
    normalizePerks({ mentorCalls: 3, feedbackCredits: 2, demoDayTickets: 1, aiBoost: true }),
    { mentorCalls: 3, feedbackCredits: 2, demoDayTickets: 1, aiBoost: true },
  );
  // Over the ceiling lands ON the ceiling — the constraint would reject more.
  assert.equal(normalizePerks({ mentorCalls: 999 }).mentorCalls, MAX_MENTOR_CALLS);
  assert.equal(normalizePerks({ feedbackCredits: 50 }).feedbackCredits, MAX_FEEDBACK_CREDITS);
  assert.equal(normalizePerks({ demoDayTickets: 50 }).demoDayTickets, MAX_DEMO_DAY_TICKETS);
  // Junk lands on nothing, never on a ceiling.
  assert.equal(normalizePerks({ mentorCalls: "lots" }).mentorCalls, 0);
  assert.equal(normalizePerks({ mentorCalls: Number.NaN }).mentorCalls, 0);
  assert.equal(normalizePerks({ mentorCalls: -4 }).mentorCalls, 0);
  assert.equal(normalizePerks({ mentorCalls: null }).mentorCalls, 0);
  // Numeric strings from a form box are fine; fractions are whole calls.
  assert.equal(normalizePerks({ mentorCalls: "4" }).mentorCalls, 4);
  assert.equal(normalizePerks({ mentorCalls: 2.9 }).mentorCalls, 2);
  // The flag is strictly boolean true — "true" the string is not a boost.
  assert.equal(normalizePerks({ aiBoost: "true" }).aiBoost, false);
  assert.equal(normalizePerks({ aiBoost: 1 }).aiBoost, false);
  assert.equal(normalizePerks({ aiBoost: true }).aiBoost, true);
});

test("hasMoney and hasAnyPerk are the two halves awardTypeOf sums", () => {
  assert.equal(hasMoney(terms()), true);
  assert.equal(hasMoney(terms({ amountCents: 0, percent: 10 })), true);
  assert.equal(hasMoney(terms({ amountCents: 0 })), false);
  assert.equal(hasAnyPerk(NO_PERKS), false);
  assert.equal(hasAnyPerk(perks({ aiBoost: true })), true);

  assert.equal(awardTypeOf(terms()), "discount");
  assert.equal(awardTypeOf(callsOnly(2)), "perks");
  assert.equal(awardTypeOf(terms({ perks: perks({ demoDayTickets: 1 }) })), "both");
  // Worth nothing reads as "discount" only so the type stays total — the form
  // and the constraint refuse it before it's ever stored.
  assert.equal(awardTypeOf(terms({ amountCents: 0 })), "discount");
});

test("perkSummaries prints each granted perk once, singular where it's one", () => {
  assert.deepEqual(perkSummaries(NO_PERKS), []);
  assert.deepEqual(perkSummaries(perks({ mentorCalls: 1 })), ["1 extra mentor call"]);
  assert.deepEqual(
    perkSummaries(perks({ mentorCalls: 3, feedbackCredits: 1, demoDayTickets: 2, aiBoost: true })),
    ["3 extra mentor calls", "1 feedback credit", "2 Demo Day guest tickets", "AI co-founder boost"],
  );
});

test("the AI boost multiplier is 1 for everyone who doesn't hold it", () => {
  assert.equal(perkAiAllowanceMultiplier(null), 1);
  assert.equal(perkAiAllowanceMultiplier(undefined), 1);
  assert.equal(perkAiAllowanceMultiplier(NO_PERKS), 1);
  assert.equal(perkAiAllowanceMultiplier(perks({ aiBoost: true })), AI_BOOST_MULTIPLIER);
  assert.ok(AI_BOOST_MULTIPLIER > 1);
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
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.stage, "accepted");
    // Open until Fall's enrollment deadline, which is what checkout honours.
    assert.equal(out.window.until, FALL.late_entry_until);
  }
});

test("checkEligibility passes an enrolled student — awards work after enrollment", () => {
  const out = checkEligibility(
    offer(),
    state({ enrolled: true, applicationStatus: "enrolled" }),
    NOW,
  );
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.stage, "enrolled");
    assert.equal(out.window.until, "2026-11-14T04:59:59.000Z");
  }
});

test("checkEligibility follows the student's cohort, not a date on the scholarship", () => {
  // The live bug: an enrolled-only perks scholarship whose own closes_at was
  // Sep 20 told every Fall student "closed" for the second half of Fall.
  const learners = offer({ eligibleStages: ["enrolled"], awardType: "perks" });
  const enrolled = state({ enrolled: true, applicationStatus: "enrolled" });
  const sep26 = checkEligibility(learners, enrolled, new Date("2026-09-26T16:00:00Z"));
  assert.equal(sep26.ok, true);
  if (sep26.ok) assert.equal(sep26.window.cohortName, "Fall 2026");

  const afterFall = checkEligibility(learners, enrolled, new Date("2026-11-14T05:00:00Z"));
  assert.equal(afterFall.ok, false);
  if (!afterFall.ok) {
    assert.equal(afterFall.reason, "closed");
    assert.equal(afterFall.message, "Fall 2026 has ended.");
  }
});

test("checkEligibility closes an accepted student's window at the enrollment deadline", () => {
  const out = checkEligibility(
    offer({ awardType: "discount" }),
    state(),
    new Date("2026-10-01T04:00:00Z"),
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, "closed");
    assert.match(out.message, /Enrollment in Fall 2026 has closed/);
  }
  // The same moment, enrolled: still open — their window runs to the end.
  assert.equal(
    checkEligibility(offer(), state({ enrolled: true }), new Date("2026-10-01T04:00:00Z")).ok,
    true,
  );
});

test("checkEligibility refuses a student with no cohort, and says why", () => {
  const out = checkEligibility(offer(), state({ cohort: null }), NOW);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, "closed");
    assert.equal(out.message, NO_COHORT_REASON);
  }
});

test("checkEligibility asks for the stage before the window", () => {
  // The window depends on the stage, and "not accepted yet" is the truer
  // answer for someone with no cohort either.
  const out = checkEligibility(offer(), state({ applicationStatus: "submitted", cohort: null }), NOW);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "stage");
});

test("checkEligibility closes when seats in the student's cohort run out", () => {
  const out = checkEligibility(offer({ seats: 3, awardedCount: 3 }), state(), NOW);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, "full");
    assert.match(out.message, /for Fall 2026/);
  }

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

test("liveStatusesInCohort scopes one-at-a-time to the cohort, and counts cohortless rows everywhere", () => {
  const rows = [
    { status: "awarded" as const, cohortId: "summer" },
    { status: "submitted" as const, cohortId: "fall" },
    { status: "declined" as const, cohortId: "fall" },
    { status: "draft" as const, cohortId: "fall" },
  ];
  // A Summer award doesn't block a Fall application…
  assert.deepEqual(liveStatusesInCohort(rows, "fall"), ["submitted"]);
  assert.deepEqual(liveStatusesInCohort(rows, "summer"), ["awarded"]);
  // …but a row with no cohort can't be told apart, so it counts in all of them.
  assert.deepEqual(
    liveStatusesInCohort([{ status: "awarded", cohortId: null }], "fall"),
    ["awarded"],
  );
  assert.deepEqual(liveStatusesInCohort(rows, null), ["awarded", "submitted"]);
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
