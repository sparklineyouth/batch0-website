import test from "node:test";
import assert from "node:assert/strict";
import {
  OPT_OUTS_THE_FORM_CANNOT_LIFT,
  mayLiftOptOut,
  planGrant,
  purposesToRestore,
  sendVerdict,
  type ConsentRow,
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

const studentGrant = { party: "student" as const, purposes: ["transactional"], source: "dashboard_phone" };

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

test("the dashboard may undo an opt-out the dashboard recorded", () => {
  const plan = planGrant(
    row({ opted_out_at: "2026-10-02T00:00:00Z", opted_out_source: "dashboard_phone" }),
    studentGrant,
  );
  assert.ok(plan.ok);
  assert.equal(plan.ok && plan.liftsOptOut, true);
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
