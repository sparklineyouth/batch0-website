import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewerOverrodePass, type DecidedApplication } from "./reapply.ts";

// The one rule that can switch the auto-admit perk off.
//
// Two features that are each correct collide here: a virtual founder pass
// admits its holder on submit, AND a declined pass holder may apply again to
// the very cohort that declined them. Without this predicate, an admin who
// deliberately declines a pass holder watches the application come straight
// back as "accepted" — with no way to make the no stick short of revoking the
// pass out from under them.
//
// Pure function, no database: the whole point of extracting it is that /apply's
// banner and the submit action reach the same verdict from the same inputs.

const REDEEMED = "2026-06-01T12:00:00.000Z";

function rejectedAt(when: string | null): DecidedApplication {
  return { status: "rejected", reviewed_at: when };
}

test("a clean history leaves the automatic seat intact", () => {
  assert.equal(reviewerOverrodePass([], REDEEMED), false);
  assert.equal(
    reviewerOverrodePass([{ status: "submitted", reviewed_at: null }], REDEEMED),
    false,
  );
});

test("a decline from BEFORE the pass was redeemed doesn't override it", () => {
  // The pass was issued knowing that history — it IS the invitation that
  // supersedes the old no. Declined in the spring, handed a pass in the
  // summer: the seat stands.
  assert.equal(
    reviewerOverrodePass([rejectedAt("2026-05-01T09:00:00+00:00")], REDEEMED),
    false,
  );
});

test("a decline from AFTER the pass was redeemed overrides it", () => {
  // That reviewer looked at this person WITH the pass in hand and still said
  // no. The next application goes back through the queue.
  assert.equal(
    reviewerOverrodePass([rejectedAt("2026-07-01T09:00:00+00:00")], REDEEMED),
    true,
  );
});

test("the comparison survives the two timestamp formats actually in play", () => {
  // reviewed_at is written by JS as "…T12:00:00.000Z"; PostgREST renders
  // redeemed_at as "…T12:00:00+00:00". Compared as strings these sort by
  // coincidence of fixed-width prefixes, which is not something that should
  // decide who gets a seat.
  assert.equal(
    reviewerOverrodePass(
      [rejectedAt("2026-06-01T11:59:59.999Z")],
      "2026-06-01T12:00:00+00:00",
    ),
    false,
  );
  assert.equal(
    reviewerOverrodePass(
      [rejectedAt("2026-06-01T12:00:00.001Z")],
      "2026-06-01T12:00:00+00:00",
    ),
    true,
  );
});

test("only declines count — a waitlist or a withdrawal is not an override", () => {
  const late = "2026-07-01T09:00:00.000Z";
  assert.equal(
    reviewerOverrodePass(
      [
        { status: "waitlisted", reviewed_at: late },
        { status: "withdrawn", reviewed_at: late },
        { status: "accepted", reviewed_at: late },
      ],
      REDEEMED,
    ),
    false,
  );
});

test("one late decline among many early ones is enough", () => {
  assert.equal(
    reviewerOverrodePass(
      [
        rejectedAt("2026-01-01T09:00:00.000Z"),
        rejectedAt("2026-02-01T09:00:00.000Z"),
        rejectedAt("2026-07-01T09:00:00.000Z"),
      ],
      REDEEMED,
    ),
    true,
  );
});

test("it fails closed on anything it can't read", () => {
  // A seat handed out over a reviewer's explicit objection is unrecoverable;
  // an unnecessary trip through the queue costs a wait. So "we couldn't tell"
  // resolves to "go through review".
  assert.equal(reviewerOverrodePass([], null), true);
  assert.equal(reviewerOverrodePass([], "not a date"), true);
  assert.equal(reviewerOverrodePass([rejectedAt("nonsense")], REDEEMED), true);
});

test("a decline with no reviewed_at doesn't override", () => {
  // Nothing recorded the moment, so nothing places it after the redemption.
  // The row predates reviewed_at being written, which makes it history.
  assert.equal(reviewerOverrodePass([rejectedAt(null)], REDEEMED), false);
});
