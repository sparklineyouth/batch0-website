import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canJoin,
  canSeeRoster,
  joinState,
  inviteEndsAt,
  normalizeQuestion,
  normalizeDisplayViewers,
  headcountLabel,
  MAX_QUESTION_LENGTH,
  MAX_DISPLAY_VIEWERS,
  JOIN_OPENS_MINUTES_BEFORE,
  JOIN_CLOSES_MINUTES_AFTER,
  DEFAULT_EVENT_MINUTES,
  type CallInvite,
  type LiveRole,
} from "./live.ts";

// Run with `npm test`. No framework, no transpile step — Node strips the types
// natively, which is why lib/live.ts is kept import-free.

const MINUTE = 60_000;
const START = new Date("2026-09-01T18:00:00Z");
const END = new Date("2026-09-01T19:00:00Z");

/** `minutes` relative to the event start. */
function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * MINUTE);
}

// ---------------------------------------------------------------------------
// Audience privacy
// ---------------------------------------------------------------------------
//
// This is the requirement most likely to be undone by accident — it is one
// boolean standing between a student and "there are 3 people watching". So it
// gets tested by role exhaustively rather than by example, and the negative
// case is the one that matters.

test("viewers can never see the roster", () => {
  assert.equal(canSeeRoster("viewer"), false);
});

test("hosts can see the roster", () => {
  assert.equal(canSeeRoster("host"), true);
});

test("no role other than host is granted roster visibility", () => {
  const ALL_ROLES: LiveRole[] = ["host", "viewer"];
  const granted = ALL_ROLES.filter(canSeeRoster);
  assert.deepEqual(
    granted,
    ["host"],
    "a new LiveRole must default to hidden — add it to this test deliberately",
  );
});

// ---------------------------------------------------------------------------
// Join window
// ---------------------------------------------------------------------------
//
// The server applies this same rule before minting a room token, so an
// off-by-one here is a door left open, not a cosmetic glitch.

test("too early to join", () => {
  assert.equal(
    joinState(START, END, at(-JOIN_OPENS_MINUTES_BEFORE - 1)),
    "early",
  );
});

test("the early window opens exactly on the boundary", () => {
  assert.equal(joinState(START, END, at(-JOIN_OPENS_MINUTES_BEFORE)), "open");
});

test("open before the start, live after it", () => {
  assert.equal(joinState(START, END, at(-1)), "open");
  assert.equal(joinState(START, END, at(0)), "live");
  assert.equal(joinState(START, END, at(30)), "live");
});

test("stays live through the grace window after the end", () => {
  assert.equal(joinState(START, END, at(60)), "live");
  assert.equal(joinState(START, END, at(60 + JOIN_CLOSES_MINUTES_AFTER)), "live");
});

test("closes once the grace window passes", () => {
  assert.equal(
    joinState(START, END, at(60 + JOIN_CLOSES_MINUTES_AFTER + 1)),
    "ended",
  );
});

test("an event with no end time is assumed to run the default length", () => {
  // Still open at the assumed end plus grace…
  assert.equal(
    joinState(START, null, at(DEFAULT_EVENT_MINUTES + JOIN_CLOSES_MINUTES_AFTER)),
    "live",
  );
  // …and closed one minute later.
  assert.equal(
    joinState(
      START,
      null,
      at(DEFAULT_EVENT_MINUTES + JOIN_CLOSES_MINUTES_AFTER + 1),
    ),
    "ended",
  );
});

test("only open and live are joinable", () => {
  assert.equal(canJoin("open"), true);
  assert.equal(canJoin("live"), true);
  assert.equal(canJoin("early"), false);
  assert.equal(canJoin("ended"), false);
});

test("joinState accepts ISO strings as well as Dates", () => {
  assert.equal(
    joinState(START.toISOString(), END.toISOString(), at(10)),
    "live",
  );
});

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

test("an invite ends its duration after it starts", () => {
  const invite = {
    id: "i1",
    hostName: "Priya",
    hostRole: "investor",
    inviteeName: "Ana",
    startsAt: START.toISOString(),
    durationMinutes: 45,
    topic: null,
    status: "accepted",
    roomName: null,
    roomUrl: null,
  } satisfies CallInvite;

  assert.equal(inviteEndsAt(invite), at(45).toISOString());
});

// ---------------------------------------------------------------------------
// Webinar Q&A
// ---------------------------------------------------------------------------
//
// normalizeQuestion is the shared truth the client button and the server
// action both read, so both the "reject" and "accept" branches matter.

test("a blank or whitespace-only question is rejected", () => {
  assert.equal(normalizeQuestion(""), null);
  assert.equal(normalizeQuestion("   "), null);
  assert.equal(normalizeQuestion("\n\n\t  \n"), null);
});

test("a real question is trimmed and kept", () => {
  assert.equal(normalizeQuestion("  How do I pitch?  "), "How do I pitch?");
});

test("runs of whitespace collapse to a single space", () => {
  // A wall of newlines can't be used to pad out the host's panel.
  assert.equal(
    normalizeQuestion("How   do\n\n\nI   pitch?"),
    "How do I pitch?",
  );
});

test("an over-long question is capped at the DB limit", () => {
  const long = "a".repeat(MAX_QUESTION_LENGTH + 50);
  const out = normalizeQuestion(long);
  assert.equal(out?.length, MAX_QUESTION_LENGTH);
});

// ---------------------------------------------------------------------------
// Announced attendance
// ---------------------------------------------------------------------------
//
// normalizeDisplayViewers is the shared truth the form, the server action, and
// the room all read, so "what counts as nothing" (null) and "what counts as a
// figure" both matter. headcountLabel is where the privacy default and the
// announced override meet — the case that must never regress is a viewer with
// no announced count seeing nothing at all.

test("an unset / blank shown-attendees value announces nothing", () => {
  assert.equal(normalizeDisplayViewers(null), null);
  assert.equal(normalizeDisplayViewers(undefined), null);
  assert.equal(normalizeDisplayViewers(""), null);
  assert.equal(normalizeDisplayViewers("   "), null);
});

test("a real shown-attendees figure is kept, from a string or a number", () => {
  assert.equal(normalizeDisplayViewers("43"), 43);
  assert.equal(normalizeDisplayViewers(43), 43);
  assert.equal(normalizeDisplayViewers("  43 "), 43);
  assert.equal(normalizeDisplayViewers(0), 0); // an explicit, deliberate zero
});

test("a fractional or negative figure is floored / rejected", () => {
  assert.equal(normalizeDisplayViewers("12.9"), 12);
  assert.equal(normalizeDisplayViewers(-5), null);
  assert.equal(normalizeDisplayViewers("nope"), null);
});

test("a wildly large figure is clamped to the cap, not rejected", () => {
  assert.equal(normalizeDisplayViewers(MAX_DISPLAY_VIEWERS + 1), MAX_DISPLAY_VIEWERS);
  assert.equal(normalizeDisplayViewers("99999999"), MAX_DISPLAY_VIEWERS);
});

test("an announced count overrides the roster for everyone, including viewers", () => {
  // The whole point of the field: the audience sees the chosen number.
  assert.deepEqual(headcountLabel({ role: "viewer", displayCount: 43, realCount: null }), {
    count: 43,
    announced: true,
  });
  // A host sees exactly what the audience sees; `announced` lets the caller
  // still surface the true roster alongside.
  assert.deepEqual(headcountLabel({ role: "host", displayCount: 43, realCount: 2 }), {
    count: 43,
    announced: true,
  });
});

test("with no announced count, the privacy default holds", () => {
  // A viewer sees nothing at all — never a "0".
  assert.equal(headcountLabel({ role: "viewer", displayCount: null, realCount: 5 }), null);
  assert.equal(headcountLabel({ role: "viewer", displayCount: null, realCount: null }), null);
  // A host sees the real roster size.
  assert.deepEqual(headcountLabel({ role: "host", displayCount: null, realCount: 5 }), {
    count: 5,
    announced: false,
  });
});

test("a backend with no client-side roster shows the announced figure or nothing", () => {
  // realCount null models Daily, which owns its own participant list.
  assert.deepEqual(headcountLabel({ role: "host", displayCount: 43, realCount: null }), {
    count: 43,
    announced: true,
  });
  assert.equal(headcountLabel({ role: "host", displayCount: null, realCount: null }), null);
});
