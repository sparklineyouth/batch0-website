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
  countsAgainstCohort,
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
  pickCallAward,
  pickPerkAward,
  stageOf,
  AI_BOOST_MULTIPLIER,
  HOLDS_AWARD_MESSAGE,
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
    assert.equal(out.window.until, "2026-11-14T04:59:59.999Z");
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
    assert.equal(out.message, HOLDS_AWARD_MESSAGE);
    assert.match(out.message, /one at a time/);
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

test("liveStatusesInCohort: an award from a cohort that's over stops blocking", () => {
  const rows = [
    { status: "awarded" as const, cohortId: "summer" },
    { status: "submitted" as const, cohortId: "fall" },
    { status: "declined" as const, cohortId: "fall" },
    { status: "draft" as const, cohortId: "fall" },
  ];
  const summerOver = new Set(["summer"]);
  // A returning student's award from a finished Summer doesn't block Fall…
  assert.deepEqual(liveStatusesInCohort(rows, "fall", summerOver), ["submitted"]);
  // …while inside Summer itself it still counts, over or not. Fall is still
  // running, so its pending row counts against Summer too.
  assert.deepEqual(liveStatusesInCohort(rows, "summer", summerOver), ["awarded", "submitted"]);
  // A row with no cohort can't be told apart, so it counts in all of them.
  assert.deepEqual(
    liveStatusesInCohort([{ status: "awarded", cohortId: null }], "fall", summerOver),
    ["awarded"],
  );
  // With no cohort of their own to compare against, everything counts.
  assert.deepEqual(liveStatusesInCohort(rows, null, summerOver), ["awarded", "submitted"]);
});

test("liveStatusesInCohort: an award from a cohort that's still running keeps blocking — one at a time", () => {
  // The Fall student accepted into Winter: their Fall Learner's award runs to
  // Nov 13. Scoping strictly per cohort let them win a Winter award beside it,
  // and the single-award perk readers then hid the Fall calls mid-cohort.
  const rows = [{ status: "awarded" as const, cohortId: "fall" }];
  assert.deepEqual(liveStatusesInCohort(rows, "winter", new Set()), ["awarded"]);
  // A pending application in a running cohort blocks a second one the same way.
  assert.deepEqual(
    liveStatusesInCohort([{ status: "under_review", cohortId: "fall" }], "winter", new Set()),
    ["under_review"],
  );
  // Once Fall is over, Winter is theirs to apply in.
  assert.deepEqual(liveStatusesInCohort(rows, "winter", new Set(["fall"])), []);
});

test("countsAgainstCohort: same cohort always, no cohort always, another cohort until it's over", () => {
  const none = new Set<string>();
  const fallOver = new Set(["fall"]);
  assert.equal(countsAgainstCohort({ cohortId: "winter" }, "winter", fallOver), true);
  assert.equal(countsAgainstCohort({ cohortId: null }, "winter", fallOver), true);
  assert.equal(countsAgainstCohort({ cohortId: "fall" }, null, fallOver), true);
  assert.equal(countsAgainstCohort({ cohortId: "fall" }, "winter", none), true);
  assert.equal(countsAgainstCohort({ cohortId: "fall" }, "winter", fallOver), false);
  // Being over never excuses a row inside the cohort being applied in.
  assert.equal(countsAgainstCohort({ cohortId: "fall" }, "fall", fallOver), true);
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

// --- choosing among a student's awards ---------------------------------------

const WINTER: ScholarshipCohort = {
  id: "winter",
  name: "Winter 2026",
  status: "upcoming",
  starts_on: "2026-12-14",
  ends_on: "2027-02-12",
  applications_close_at: "2026-12-12T23:59:00Z",
  late_entry_until: null,
  catch_up_plan: null,
};

/** An award as listAwardsForUser hands it over: the snapshot plus its cohort. */
function held(
  id: string,
  cohort: ScholarshipCohort | null,
  granted: AwardPerks,
  callsUsed = 0,
) {
  return {
    id,
    app: { credits: callCredits(granted.mentorCalls, callsUsed), perks: granted },
    cohort,
  };
}

test("a newer Winter award without calls doesn't hide a running Fall award's calls or perks", () => {
  // Sep 25: a Fall student is awarded the Learner's Scholarship (3 calls, 1
  // used, a feedback credit). Oct 10: a Winter discount award is decided.
  // Newest first, as listAwardsForUser returns them.
  const awards = [
    held("winter-discount", WINTER, perks()),
    held("fall-learner", FALL, perks({ mentorCalls: 3, feedbackCredits: 1 }), 1),
  ];
  const oct10 = new Date("2026-10-10T16:00:00Z");
  assert.equal(pickCallAward(awards, oct10)?.id, "fall-learner");
  assert.equal(pickPerkAward(awards, oct10)?.id, "fall-learner");
});

test("pickCallAward prefers an award that can book now over a newer one that can't", () => {
  const oct10 = new Date("2026-10-10T16:00:00Z");
  // Winter's calls are all used; Fall's still have one left and Fall is running.
  const awards = [
    held("winter", WINTER, perks({ mentorCalls: 2 }), 2),
    held("fall", FALL, perks({ mentorCalls: 3 }), 2),
  ];
  assert.equal(pickCallAward(awards, oct10)?.id, "fall");
  // Once Fall has ended its calls can't be booked, so Winter speaks for them —
  // and says "all used" rather than the card disappearing.
  assert.equal(pickCallAward(awards, new Date("2026-11-20T16:00:00Z"))?.id, "winter");
});

test("pickCallAward falls back to the newest calls award so the card can say why booking is closed", () => {
  const nov20 = new Date("2026-11-20T16:00:00Z");
  // Fall is over and the newer award carries no calls: Fall's award still
  // answers, and its window explains the closure.
  const awards = [held("winter", WINTER, perks()), held("fall", FALL, perks({ mentorCalls: 3 }))];
  assert.equal(pickCallAward(awards, nov20)?.id, "fall");
  // No award granted calls at all: nothing to show.
  assert.equal(pickCallAward([held("w", WINTER, perks({ aiBoost: true }))], nov20), null);
  assert.equal(pickCallAward([], nov20), null);
});

test("pickCallAward treats a legacy award with no cohort as bookable", () => {
  const awards = [held("legacy", null, perks({ mentorCalls: 2 }))];
  assert.equal(pickCallAward(awards, NOW)?.id, "legacy");
});

test("pickPerkAward takes the newest award with perks whose cohort isn't over, else the newest with perks", () => {
  const oct10 = new Date("2026-10-10T16:00:00Z");
  const nov20 = new Date("2026-11-20T16:00:00Z");
  const bothWithPerks = [
    held("winter", WINTER, perks({ demoDayTickets: 2 })),
    held("fall", FALL, perks({ aiBoost: true })),
  ];
  // Both running: the newer one.
  assert.equal(pickPerkAward(bothWithPerks, oct10)?.id, "winter");
  // An older award whose cohort is over loses to a running one, whatever the order.
  const fallOverNewer = [
    held("fall", FALL, perks({ aiBoost: true })),
    held("winter", WINTER, perks({ demoDayTickets: 2 })),
  ];
  assert.equal(pickPerkAward(fallOverNewer, nov20)?.id, "winter");
  // Nothing running carries perks: a perk doesn't lapse with its cohort.
  const onlyFallHasPerks = [held("winter", WINTER, perks()), held("fall", FALL, perks({ aiBoost: true }))];
  assert.equal(pickPerkAward(onlyFallHasPerks, nov20)?.id, "fall");
  // A legacy award with no cohort isn't "over".
  assert.equal(pickPerkAward([held("legacy", null, perks({ feedbackCredits: 1 }))], nov20)?.id, "legacy");
  assert.equal(pickPerkAward([held("w", WINTER, perks())], oct10), null);
});
