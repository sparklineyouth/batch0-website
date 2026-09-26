import { test } from "node:test";
import assert from "node:assert/strict";
import {
  challengeWindowState,
  isChallengeOpen,
  type Challenge,
} from "./challenges-shared.ts";

// Run with `npm test`. The window helper is a gate, so these cover the cases
// that let the WRONG state through — above all a challenge whose window is
// still ahead reading as "closed", which told visitors it had wrapped up.

const NOW = new Date("2026-09-26T12:00:00Z").getTime();

function challenge(over: Partial<Challenge>): Challenge {
  return {
    status: "active",
    opensAt: null,
    closesAt: null,
    ...over,
  } as Challenge;
}

test("open when active with no window set", () => {
  assert.equal(challengeWindowState(challenge({}), NOW), "open");
});

test("upcoming while opensAt is still ahead", () => {
  const c = challenge({
    opensAt: "2026-10-01T04:00:00Z",
    closesAt: "2026-10-11T03:59:59Z",
  });
  assert.equal(challengeWindowState(c, NOW), "upcoming");
  assert.equal(isChallengeOpen(c, NOW), false);
});

test("open once opensAt has passed and closesAt has not", () => {
  const c = challenge({
    opensAt: "2026-10-01T04:00:00Z",
    closesAt: "2026-10-11T03:59:59Z",
  });
  const during = new Date("2026-10-05T12:00:00Z").getTime();
  assert.equal(challengeWindowState(c, during), "open");
  assert.equal(isChallengeOpen(c, during), true);
});

test("closed once closesAt has passed", () => {
  const c = challenge({
    opensAt: "2026-10-01T04:00:00Z",
    closesAt: "2026-10-11T03:59:59Z",
  });
  const after = new Date("2026-10-12T00:00:00Z").getTime();
  assert.equal(challengeWindowState(c, after), "closed");
});

test("boundaries are inclusive at both ends", () => {
  const opens = "2026-10-01T04:00:00Z";
  const closes = "2026-10-11T03:59:59Z";
  const c = challenge({ opensAt: opens, closesAt: closes });
  assert.equal(challengeWindowState(c, new Date(opens).getTime()), "open");
  assert.equal(challengeWindowState(c, new Date(closes).getTime()), "open");
});

test("a non-active challenge is never upcoming, whatever its window says", () => {
  for (const status of ["draft", "closed", "archived"] as const) {
    const c = challenge({ status, opensAt: "2026-10-01T04:00:00Z" });
    assert.equal(challengeWindowState(c, NOW), "closed");
    assert.equal(isChallengeOpen(c, NOW), false);
  }
});
