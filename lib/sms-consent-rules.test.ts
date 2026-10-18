import test from "node:test";
import assert from "node:assert/strict";
import {
  OPT_OUTS_THE_FORM_CANNOT_LIFT,
  campaignMayText,
  mayLiftOptOut,
  planGrant,
  purposesToRestore,
  sendVerdict,
  stopShouldBeRecorded,
  unrecordedOptOuts,
  type ConsentRow,
  type LedgerRow,
} from "./sms/consent-rules.ts";
import { PURPOSE_REFUSED } from "./sms/policy.ts";

// Run with `npm test`. The decisions lib/sms/consent.ts writes to the
// database, tested against plain rows. Every rule here was a real hole at some
// point — a web form erasing a STOP, a student number relabelled as a parent's
// in the same statement that made it marketable, a START that widened what a
// number had agreed to — so each one is pinned in both directions.

const row = (over: Partial<ConsentRow> = {}): ConsentRow => ({
  party: "student",
  transactional: true,
  promotional: false,
  opted_out_at: null,
  opted_out_source: null,
  first_opted_in_at: "2026-10-01T12:00:00Z",
  ...over,
});

const studentGrant = {
  party: "student" as const,
  purposes: ["transactional"],
  source: "dashboard_phone",
  userId: "student-a",
};

// ---------------------------------------------------------------------------
// Marketing is off
// ---------------------------------------------------------------------------

test("no grant can record promotional consent while marketing texts are off", () => {
  // Not even for a parent, and not even mixed in with a program purpose: the
  // privacy policy promises no marketing texts, so nothing may record consent
  // for them.
  for (const party of ["student", "parent", "unknown"] as const) {
    const plan = planGrant(null, { party, purposes: ["promotional"], source: "dashboard_phone" });
    assert.deepEqual(plan, { ok: false, error: PURPOSE_REFUSED }, party);
    const mixed = planGrant(null, { party, purposes: ["transactional", "promotional"], source: "sms_start" });
    assert.equal(mixed.ok, false, `${party}, mixed purposes`);
  }
});

test("the gate refuses a promotional send even to a row that somehow says yes", () => {
  // A row written by something other than this app — a hand edit, a future
  // migration — still can't produce a marketing text.
  const v = sendVerdict(row({ party: "parent", promotional: true }), "promotional");
  assert.deepEqual(v, { allowed: false, reason: PURPOSE_REFUSED });
});

test("an unknown purpose is refused, not treated as transactional", () => {
  assert.equal(sendVerdict(row(), "marketing").allowed, false);
  assert.equal(planGrant(null, { ...studentGrant, purposes: ["marketing"] }).ok, false);
  assert.equal(planGrant(null, { ...studentGrant, purposes: [] }).ok, false);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("the gate says yes only to a live program-text consent", () => {
  assert.deepEqual(sendVerdict(row(), "transactional"), { allowed: true, party: "student" });
  assert.equal(sendVerdict(null, "transactional").allowed, false, "no row is no consent");
  assert.equal(sendVerdict(row({ transactional: false }), "transactional").allowed, false);
});

test("an opt-out outranks the purpose flags", () => {
  // The flags survive an opt-out on purpose (so START restores exactly them),
  // which is why the gate has to read opted_out_at first.
  const v = sendVerdict(row({ opted_out_at: "2026-10-02T00:00:00Z", opted_out_source: "sms_stop" }), "transactional");
  assert.deepEqual(v, { allowed: false, reason: "This number has opted out." });
});

// ---------------------------------------------------------------------------
// Who may lift an opt-out
// ---------------------------------------------------------------------------

test("a STOP, a carrier block, or an admin-recorded request can't be lifted by the web form", () => {
  for (const source of ["sms_stop", "provider_21610", "admin"]) {
    assert.ok(OPT_OUTS_THE_FORM_CANNOT_LIFT.has(source), source);
    assert.equal(mayLiftOptOut(source, "dashboard_phone"), false, source);
    const plan = planGrant(row({ opted_out_at: "2026-10-02T00:00:00Z", opted_out_source: source }), studentGrant);
    assert.equal(plan.ok, false, `${source} lifted by the form`);
  }
});

test("a guardian's request recorded by an admin outlasts the student re-ticking the box", () => {
  // The privacy policy lets a parent tell us to stop texting their student.
  // If the student could undo that from the dashboard, it would last exactly
  // until they next saved the page.
  const plan = planGrant(
    row({ opted_out_at: "2026-10-02T00:00:00Z", opted_out_source: "admin" }),
    studentGrant,
  );
  assert.equal(plan.ok, false);
  assert.match(plan.ok ? "" : plan.error, /START/);
});

test("START from the phone lifts any opt-out", () => {
  for (const source of ["sms_stop", "provider_21610", "admin", "dashboard_phone"]) {
    assert.equal(mayLiftOptOut(source, "sms_start"), true, source);
    const plan = planGrant(row({ opted_out_at: "2026-10-02T00:00:00Z", opted_out_source: source }), {
      party: "student",
      purposes: ["transactional"],
      source: "sms_start",
    });
    assert.ok(plan.ok, source);
    assert.equal(plan.ok && plan.liftsOptOut, true);
  }
});

test("the dashboard may undo an opt-out the same account recorded there", () => {
  const plan = planGrant(
    row({ opted_out_at: "2026-10-02T00:00:00Z", opted_out_source: "dashboard_phone", opted_out_by: "student-a" }),
    studentGrant,
  );
  assert.ok(plan.ok);
  assert.equal(plan.ok && plan.liftsOptOut, true);
});

test("another account can't undo a dashboard opt-out by saving the same number", () => {
  // Siblings share a phone. A turns texts off; B saves the shared number on
  // B's own dashboard with the box ticked. That is not A agreeing again.
  const optedOut = row({
    opted_out_at: "2026-10-02T00:00:00Z",
    opted_out_source: "dashboard_phone",
    opted_out_by: "student-a",
  });
  const plan = planGrant(optedOut, { ...studentGrant, userId: "student-b" });
  assert.equal(plan.ok, false);
  assert.match(plan.ok ? "" : plan.error, /another batch0 account/);
  assert.match(plan.ok ? "" : plan.error, /START/);
  assert.equal(mayLiftOptOut("dashboard_phone", "dashboard_phone", { optedOutBy: "student-a", userId: "student-b" }), false);
  // Nor with no account on either side to match: unknown is not "the same".
  assert.equal(mayLiftOptOut("dashboard_phone", "dashboard_phone", { optedOutBy: null, userId: "student-a" }), false);
  assert.equal(mayLiftOptOut("dashboard_phone", "dashboard_phone", { optedOutBy: "student-a", userId: null }), false);
  assert.equal(mayLiftOptOut("dashboard_phone", "dashboard_phone"), false);
  // START from the phone still lifts it, whoever's account it was.
  assert.equal(mayLiftOptOut("dashboard_phone", "sms_start", { optedOutBy: "student-a" }), true);
});

test("an opt-out source the rules don't know stays suppressed until START", () => {
  // Allowlist, not denylist: a new revoke path must not become form-liftable
  // by default.
  for (const source of [null, "", "something_new"]) {
    assert.equal(mayLiftOptOut(source, "dashboard_phone", { optedOutBy: "student-a", userId: "student-a" }), false, String(source));
  }
});

test("a STOP onto a dashboard opt-out is recorded; onto a STOP it is not", () => {
  // From the phone, a STOP has to lock the number even when the dashboard had
  // already turned texts off — otherwise the form could still lift it.
  assert.equal(stopShouldBeRecorded(null), true, "no row: record it");
  assert.equal(stopShouldBeRecorded(row()), true, "opted in: record it");
  assert.equal(
    stopShouldBeRecorded(row({ opted_out_at: "2026-10-02T00:00:00Z", opted_out_source: "dashboard_phone", opted_out_by: "student-a" })),
    true,
  );
  for (const source of ["sms_stop", "provider_21610", "admin"]) {
    assert.equal(
      stopShouldBeRecorded(row({ opted_out_at: "2026-10-02T00:00:00Z", opted_out_source: source })),
      false,
      source,
    );
  }
});

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

test("a number on file as one party can't be relabelled as the other by a grant", () => {
  assert.equal(planGrant(row({ party: "student" }), { ...studentGrant, party: "parent" }).ok, false);
  assert.equal(planGrant(row({ party: "parent", transactional: true }), studentGrant).ok, false);
});

test("an unknown party is adopted, and a student grant keeps the number a student's", () => {
  const plan = planGrant(row({ party: "unknown" }), studentGrant);
  assert.ok(plan.ok);
  assert.equal(plan.ok && plan.party, "student");
  const fresh = planGrant(null, studentGrant);
  assert.ok(fresh.ok);
  assert.equal(fresh.ok && fresh.party, "student");
  assert.equal(fresh.ok && fresh.transactional, true);
  assert.equal(fresh.ok && fresh.promotional, false);
  assert.equal(fresh.ok && fresh.liftsOptOut, false);
});

test("a student grant can't land on a number that already carries promotional consent", () => {
  // 0106's CHECK would reject the merged row; this catches it before the
  // ledger row is written, so the student isn't left with an unfixable opt-in.
  const plan = planGrant(row({ party: "unknown", promotional: true }), studentGrant);
  assert.equal(plan.ok, false);
});

// ---------------------------------------------------------------------------
// The admin's own-phone test opt-in
// ---------------------------------------------------------------------------

test("an admin can opt their own new number in for a test", () => {
  const plan = planGrant(null, { party: "unknown", purposes: ["transactional"], source: "admin_test" });
  assert.ok(plan.ok);
  assert.equal(plan.ok && plan.party, "unknown");
});

test("an admin test opt-in can't touch a student's number or lift anyone's opt-out", () => {
  const admin = { party: "unknown" as const, purposes: ["transactional"], source: "admin_test" };
  // A student's number, opted in or not.
  assert.equal(planGrant(row({ party: "student", transactional: false }), admin).ok, false);
  assert.equal(planGrant(row({ party: "student" }), admin).ok, false);
  // Any opt-out — even one the dashboard recorded, which the dashboard itself
  // could lift. The admin typing the number may not be its owner.
  for (const source of ["sms_stop", "provider_21610", "admin", "dashboard_phone"]) {
    assert.equal(mayLiftOptOut(source, "admin_test"), false, source);
    const plan = planGrant(row({ party: "unknown", opted_out_at: "2026-10-02T00:00:00Z", opted_out_source: source }), admin);
    assert.equal(plan.ok, false, source);
  }
});

test("an admin's test opt-in reaches test sends, never a campaign", () => {
  // The audience is students' application numbers; only a student's own tick
  // (party student) speaks for one. A test opt-in writes party unknown.
  assert.equal(campaignMayText(row()), true);
  assert.equal(campaignMayText(row({ party: "unknown" })), false);
  assert.equal(campaignMayText(row({ party: "parent" })), false);
  assert.equal(campaignMayText(row({ opted_out_at: "2026-10-02T00:00:00Z", opted_out_source: "sms_stop" })), false);
  assert.equal(campaignMayText(row({ transactional: false })), false);
  assert.equal(campaignMayText(null), false);
  // And the send gate itself still lets the test through.
  assert.equal(sendVerdict(row({ party: "unknown" }), "transactional").allowed, true);
});

// ---------------------------------------------------------------------------
// Opt-outs the webhook didn't record
// ---------------------------------------------------------------------------

test("an opt-out text with nothing after it in the ledger is owed", () => {
  const P = "+16095550123";
  const inbound = [
    { phone_e164: P, body: "what time is the call", created_at: "2026-10-16T10:00:00Z" },
    { phone_e164: P, body: "please stop texting me", created_at: "2026-10-16T12:00:00Z" },
  ];
  const owed = unrecordedOptOuts(inbound, new Map([[P, row()]]), []);
  assert.deepEqual(owed, [{ phone: P, body: "please stop texting me", at: "2026-10-16T12:00:00Z" }]);
});

test("a recorded revoke, a later START, or a STOP-locked number settles it", () => {
  const P = "+16095550123";
  const stop = [{ phone_e164: P, body: "STOP", created_at: "2026-10-16T12:00:00Z" }];
  const ledger = (entries: Partial<LedgerRow>[]): LedgerRow[] =>
    entries.map((e) => ({ phone_e164: P, action: "revoke", source: "sms_stop", created_at: "2026-10-16T12:00:01Z", ...e }));
  const consented = new Map([[P, row()]]);

  assert.deepEqual(unrecordedOptOuts(stop, consented, ledger([{}])), [], "the webhook recorded it");
  assert.deepEqual(
    unrecordedOptOuts(stop, consented, ledger([{ action: "grant", source: "sms_start", created_at: "2026-10-16T13:00:00Z" }])),
    [],
    "they texted START afterwards",
  );
  assert.deepEqual(
    unrecordedOptOuts(stop, new Map([[P, row({ opted_out_at: "2026-10-01T00:00:00Z", opted_out_source: "sms_stop" })]]), []),
    [],
    "a second STOP onto a STOP changes nothing",
  );
  // A revoke from BEFORE the text doesn't answer it.
  assert.equal(unrecordedOptOuts(stop, consented, ledger([{ created_at: "2026-10-15T00:00:00Z" }])).length, 1);
  // A later dashboard tick doesn't either: it would have been refused had the
  // STOP been recorded.
  assert.equal(
    unrecordedOptOuts(stop, consented, ledger([{ action: "grant", source: "dashboard_phone", created_at: "2026-10-16T13:00:00Z" }])).length,
    1,
  );
  // Nor does a dashboard opt-out: the STOP still has to lock it.
  assert.equal(
    unrecordedOptOuts(stop, new Map([[P, row({ opted_out_at: "2026-10-01T00:00:00Z", opted_out_source: "dashboard_phone" })]]), []).length,
    1,
  );
});

test("questions, HELP and START are never read as opt-outs", () => {
  const P = "+16095550123";
  const inbound = ["HELP", "START", "Can you stop by on Thursday?", "ok thanks"].map((body, i) => ({
    phone_e164: P,
    body,
    created_at: `2026-10-16T1${i}:00:00Z`,
  }));
  assert.deepEqual(unrecordedOptOuts(inbound, new Map([[P, row()]]), []), []);
  assert.deepEqual(unrecordedOptOuts([{ phone_e164: null, body: "STOP", created_at: "2026-10-16T10:00:00Z" }], new Map(), []), []);
});

// ---------------------------------------------------------------------------
// START restores, never widens
// ---------------------------------------------------------------------------

test("START restores exactly the purposes already agreed, and only allowed ones", () => {
  assert.deepEqual(purposesToRestore(row()), ["transactional"]);
  assert.deepEqual(purposesToRestore(row({ transactional: false })), []);
  assert.deepEqual(purposesToRestore(null), []);
  // A promotional flag on the row is not restored while marketing is off.
  assert.deepEqual(purposesToRestore(row({ party: "parent", promotional: true })), ["transactional"]);
  assert.deepEqual(purposesToRestore(row({ party: "parent", transactional: false, promotional: true })), []);
});
