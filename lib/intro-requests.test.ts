import { test } from "node:test";
import assert from "node:assert/strict";
import { introRequestDecision, MAX_OPEN_INTRO_REQUESTS } from "./intro-requests.ts";

// Run with `npm test`. What createIntroRequest (app/investor/teams/[id]/actions.ts)
// does with one more request from an investor.

test("a first request is filed while the investor has room", () => {
  assert.deepEqual(introRequestDecision({ existing: null, openCount: 0 }), { kind: "create" });
  assert.deepEqual(
    introRequestDecision({ existing: null, openCount: MAX_OPEN_INTRO_REQUESTS - 1 }),
    { kind: "create" },
  );
});

test("one investor can't hold more than the cap open in the admin queue", () => {
  const d = introRequestDecision({ existing: null, openCount: MAX_OPEN_INTRO_REQUESTS });
  assert.equal(d.kind, "refuse");
  assert.match(d.kind === "refuse" ? d.message : "", /Once we've acted on one/);
  assert.equal(introRequestDecision({ existing: null, openCount: 40 }).kind, "refuse");
});

test("rewording a request that is still waiting is always allowed, even at the cap", () => {
  assert.deepEqual(
    introRequestDecision({ existing: { status: "requested" }, openCount: MAX_OPEN_INTRO_REQUESTS }),
    { kind: "update-message" },
  );
});

test("a request the team already moved on is never reset to new", () => {
  for (const status of ["intro_made", "meeting_held", "committed", "wired", "passed"]) {
    assert.equal(introRequestDecision({ existing: { status }, openCount: 0 }).kind, "refuse", status);
  }
});
