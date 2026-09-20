import test from "node:test";
import assert from "node:assert/strict";
import { recoveryBlocker, recoveryContext } from "./email-recovery.ts";
const app = { id: "a", user_id: "u", cohort_id: "fall", status: "accepted" };
test("a payment in Winter does not suppress eligible Fall follow-up", () => {
  assert.equal(recoveryBlocker(app, [{user_id:"u",cohort_id:"winter",status:"succeeded"}], []), null);
});
test("payment, enrollment, refund and an explicit pause each suppress a nudge", () => {
  assert.match(recoveryBlocker(app, [{user_id:"u",cohort_id:"fall",status:"succeeded"}], [])!, /paid/);
  assert.match(recoveryBlocker(app, [], [{user_id:"u",cohort_id:"fall"}])!, /enrolled/);
  assert.match(recoveryBlocker(app, [{user_id:"u",cohort_id:"fall",status:"refunded"}], [])!, /Refund/);
  assert.match(recoveryBlocker({...app,followup_paused:true}, [], [])!, /paused/);
});
test("duplicate expired attempts are not customers and do not suppress real intent", () => {
  assert.equal(recoveryBlocker(app, Array(4).fill({user_id:"u",cohort_id:"fall",status:"failed"}), []), null);
});
test("missing identity and decisions other than accepted fail closed", () => {
  assert.ok(recoveryBlocker(null, [], []));
  assert.ok(recoveryBlocker({...app,status:"rejected"}, [], []));
});
test("context accepts only UUID identifiers, not arbitrary merge-tag input", () => {
  assert.deepEqual(recoveryContext({application_id:"not-an-id",cohort_id:42}), {applicationId:null,cohortId:null});
  const id="6350c6ac-70f0-4f53-93d5-c99e397185a9";
  assert.deepEqual(recoveryContext({application_id:id,cohort_id:id}), {applicationId:id,cohortId:id});
});
