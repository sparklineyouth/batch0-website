import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoCompleteCutoff,
  bookingPrefill,
  callBadge,
  callEndsAt,
  callPhase,
  canCancelCall,
  canMarkCallCompleted,
  canRespondToCall,
  canUploadCallRecording,
  canViewCallRecording,
  formatEasternDateTime,
  hostCallsHref,
  interviewCardState,
  interviewStage,
  isPastPhase,
  proposalsAllPast,
  RECORDING_UPLOAD_GRACE_MINUTES,
  shouldAutoComplete,
  splitCalls,
  type CallPhase,
  type CallTiming,
} from "./call-lifecycle.ts";
import {
  JOIN_CLOSES_MINUTES_AFTER,
  JOIN_OPENS_MINUTES_BEFORE,
  type CallInviteStatus,
} from "./live.ts";

// Run with `npm test`. Every assertion pins `now`, because the whole point of
// this module is that the answer depends on the clock and nothing else.

const MINUTE = 60_000;
const START = "2026-09-19T21:30:00.000Z";
const DURATION = 30;

/** `minutes` relative to the call's start. */
function at(minutes: number): Date {
  return new Date(new Date(START).getTime() + minutes * MINUTE);
}

function call(status: CallInviteStatus, over: Partial<CallTiming> = {}): CallTiming {
  return { status, startsAt: START, durationMinutes: DURATION, ...over };
}

// The last minute of the join window, and the first minute after it.
const LAST_OPEN = DURATION + JOIN_CLOSES_MINUTES_AFTER;
const FIRST_CLOSED = LAST_OPEN + 1;

// ---------------------------------------------------------------------------
// callPhase
// ---------------------------------------------------------------------------

test("an accepted call walks upcoming → joinable → live → ended with the clock", () => {
  const c = call("accepted");
  assert.equal(callPhase(c, at(-JOIN_OPENS_MINUTES_BEFORE - 1)), "upcoming");
  assert.equal(callPhase(c, at(-JOIN_OPENS_MINUTES_BEFORE)), "joinable");
  assert.equal(callPhase(c, at(-1)), "joinable");
  assert.equal(callPhase(c, at(0)), "live");
  assert.equal(callPhase(c, at(LAST_OPEN)), "live");
  assert.equal(callPhase(c, at(FIRST_CLOSED)), "ended");
});

test("the production case: an accepted call from a week ago is ended, not upcoming", () => {
  // 2026-09-19 21:30Z, 30 minutes, looked at on 2026-09-26.
  const c = call("accepted");
  assert.equal(callPhase(c, new Date("2026-09-26T15:30:00Z")), "ended");
  assert.equal(isPastPhase("ended"), true);
});

test("an unanswered invite stays answerable until the window closes, then expires", () => {
  const c = call("invited");
  assert.equal(callPhase(c, at(-60 * 24)), "needs_answer");
  // Accepting five minutes in is still a call they can join.
  assert.equal(callPhase(c, at(5)), "needs_answer");
  assert.equal(callPhase(c, at(LAST_OPEN)), "needs_answer");
  assert.equal(callPhase(c, at(FIRST_CLOSED)), "expired");
});

test("decisions are final whatever the clock says", () => {
  for (const now of [at(-600), at(0), at(600)]) {
    assert.equal(callPhase(call("declined"), now), "declined");
    assert.equal(callPhase(call("cancelled"), now), "cancelled");
    assert.equal(callPhase(call("completed"), now), "completed");
  }
});

test("an unrecognised status is treated as cancelled, never as joinable", () => {
  const weird = call("archived" as CallInviteStatus);
  assert.equal(callPhase(weird, at(0)), "cancelled");
  assert.equal(canCancelCall(weird, at(0)), false);
  assert.equal(canRespondToCall(weird, at(-600)), false);
});

test("duration moves the end of the window", () => {
  const long = call("accepted", { durationMinutes: 240 });
  assert.equal(callPhase(long, at(240 + JOIN_CLOSES_MINUTES_AFTER)), "live");
  assert.equal(callPhase(long, at(240 + JOIN_CLOSES_MINUTES_AFTER + 1)), "ended");
  assert.equal(
    callEndsAt(START, 45).toISOString(),
    "2026-09-19T22:15:00.000Z",
  );
});

// ---------------------------------------------------------------------------
// What each side may do
// ---------------------------------------------------------------------------

test("a past invite can no longer be accepted or declined", () => {
  const c = call("invited");
  assert.equal(canRespondToCall(c, at(-10)), true);
  assert.equal(canRespondToCall(c, at(FIRST_CLOSED)), false);
  assert.equal(canRespondToCall(call("accepted"), at(-600)), false);
});

test("a call can be cancelled until its window closes, and never after", () => {
  assert.equal(canCancelCall(call("invited"), at(-600)), true);
  assert.equal(canCancelCall(call("accepted"), at(-600)), true);
  assert.equal(canCancelCall(call("accepted"), at(10)), true, "a no-show can still be called off");
  assert.equal(canCancelCall(call("accepted"), at(FIRST_CLOSED)), false);
  assert.equal(canCancelCall(call("invited"), at(FIRST_CLOSED)), false);
});

test("cancelled, declined and completed calls can't be cancelled again (no second refund)", () => {
  for (const s of ["cancelled", "declined", "completed"] as const) {
    assert.equal(canCancelCall(call(s), at(-600)), false, s);
  }
});

test("End call marks completed only once the call has started", () => {
  assert.equal(canMarkCallCompleted(call("accepted"), at(-5)), false);
  assert.equal(canMarkCallCompleted(call("accepted"), at(0)), true);
  assert.equal(canMarkCallCompleted(call("accepted"), at(FIRST_CLOSED + 60)), true);
  assert.equal(canMarkCallCompleted(call("invited"), at(5)), false);
  assert.equal(canMarkCallCompleted(call("cancelled"), at(5)), false);
});

test("recording uploads are open from the room opening to a short grace after it closes", () => {
  const c = call("accepted");
  assert.equal(canUploadCallRecording(c, at(-JOIN_OPENS_MINUTES_BEFORE - 1)), false);
  assert.equal(canUploadCallRecording(c, at(-JOIN_OPENS_MINUTES_BEFORE)), true);
  assert.equal(canUploadCallRecording(c, at(10)), true);
  // The room closes itself at the window's end and flushes; that last segment
  // lands just after, and must still be accepted.
  assert.equal(canUploadCallRecording(c, at(FIRST_CLOSED)), true);
  assert.equal(
    canUploadCallRecording(c, at(LAST_OPEN + RECORDING_UPLOAD_GRACE_MINUTES)),
    true,
  );
  assert.equal(
    canUploadCallRecording(c, at(LAST_OPEN + RECORDING_UPLOAD_GRACE_MINUTES + 1)),
    false,
  );
});

test("the host may finish uploading after the student ends the call, but never for a dead call", () => {
  assert.equal(canUploadCallRecording(call("completed"), at(10)), true);
  for (const s of ["invited", "declined", "cancelled"] as const) {
    assert.equal(canUploadCallRecording(call(s), at(10)), false, s);
  }
});

test("the sweep completes accepted calls whose window has closed, and nothing else", () => {
  assert.equal(shouldAutoComplete(call("accepted"), at(LAST_OPEN)), false);
  assert.equal(shouldAutoComplete(call("accepted"), at(FIRST_CLOSED)), true);
  assert.equal(shouldAutoComplete(call("invited"), at(FIRST_CLOSED)), false);
  assert.equal(shouldAutoComplete(call("completed"), at(FIRST_CLOSED)), false);
  assert.equal(shouldAutoComplete(call("cancelled"), at(FIRST_CLOSED)), false);
});

test("the sweep's prefilter never excludes a call that is due", () => {
  // The shortest call the CHECK allows is five minutes; its window closes
  // JOIN_CLOSES_MINUTES_AFTER after that. Anything due must start before the
  // cutoff, or the database filter would hide it from the exact check.
  const now = new Date("2026-09-26T12:00:00Z");
  const cutoff = autoCompleteCutoff(now).getTime();
  for (const duration of [5, 30, 240]) {
    // The latest start for which this call is already due.
    const latestDueStart =
      now.getTime() - (duration + JOIN_CLOSES_MINUTES_AFTER) * MINUTE - 1;
    const c = call("accepted", {
      durationMinutes: duration,
      startsAt: new Date(latestDueStart).toISOString(),
    });
    assert.equal(shouldAutoComplete(c, now), true, `duration ${duration}`);
    assert.ok(latestDueStart <= cutoff, `duration ${duration} passes the prefilter`);
  }
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

test("splitCalls: upcoming soonest-first, past newest-first, by phase not status", () => {
  const now = at(0);
  const mk = (id: string, status: CallInviteStatus, startOffset: number) => ({
    id,
    ...call(status, { startsAt: at(startOffset).toISOString() }),
  });
  const calls = [
    mk("far", "accepted", 60 * 24 * 7),
    mk("soon", "accepted", 60),
    mk("live", "accepted", -5),
    mk("ask", "invited", 60 * 24),
    mk("oldAccepted", "accepted", -60 * 24 * 7),
    mk("expired", "invited", -60 * 24),
    mk("cancelledFuture", "cancelled", 60 * 24),
    mk("done", "completed", -60 * 2),
  ];
  const { upcoming, past } = splitCalls(calls, now);
  assert.deepEqual(
    upcoming.map((c) => c.id),
    ["live", "soon", "ask", "far"],
  );
  assert.deepEqual(
    past.map((c) => c.id),
    ["cancelledFuture", "done", "expired", "oldAccepted"],
  );
});

test("splitCalls does not mutate its input", () => {
  const input = [
    { ...call("accepted", { startsAt: at(60).toISOString() }) },
    { ...call("accepted", { startsAt: at(10).toISOString() }) },
  ];
  const before = input.map((c) => c.startsAt);
  splitCalls(input, at(0));
  assert.deepEqual(input.map((c) => c.startsAt), before);
});

test("every phase has a badge, and only history counts as past", () => {
  const ALL: CallPhase[] = [
    "needs_answer",
    "expired",
    "upcoming",
    "joinable",
    "live",
    "ended",
    "completed",
    "declined",
    "cancelled",
  ];
  for (const p of ALL) assert.ok(callBadge(p).length > 0, p);
  assert.deepEqual(
    ALL.filter(isPastPhase),
    ["expired", "ended", "completed", "declined", "cancelled"],
  );
  // An ended call must never be labelled as if it were still accepted.
  assert.equal(callBadge("ended"), "ended");
});

// ---------------------------------------------------------------------------
// Interview requests
// ---------------------------------------------------------------------------

test("interviewStage reads a scheduled request through its call", () => {
  const scheduled = (c: CallTiming | null) => ({ status: "scheduled", call: c });
  assert.equal(interviewStage(null, at(0)), null);
  assert.equal(interviewStage({ status: "requested", call: null }, at(0)), "requested");
  assert.equal(interviewStage(scheduled(call("invited")), at(-60)), "booked");
  assert.equal(interviewStage(scheduled(call("accepted")), at(-60)), "booked");
  assert.equal(interviewStage(scheduled(call("accepted")), at(10)), "booked");
  assert.equal(interviewStage(scheduled(call("accepted")), at(FIRST_CLOSED)), "done");
  assert.equal(interviewStage(scheduled(call("completed")), at(0)), "done");
  // The production cases: "Interview booked" over a cancelled or finished call.
  assert.equal(interviewStage(scheduled(call("cancelled")), at(-60)), "fell_through");
  assert.equal(interviewStage(scheduled(call("declined")), at(-60)), "fell_through");
  assert.equal(interviewStage(scheduled(call("invited")), at(FIRST_CLOSED)), "fell_through");
  assert.equal(interviewStage(scheduled(null), at(0)), "fell_through");
  assert.equal(interviewStage({ status: "declined", call: null }, at(0)), null);
  assert.equal(interviewStage({ status: "cancelled", call: null }, at(0)), null);
});

test("interviewCardState: a request in flight always shows; asking needs eligibility", () => {
  assert.equal(interviewCardState("requested", false), "requested");
  assert.equal(interviewCardState("booked", false), "booked");
  assert.equal(interviewCardState("done", false), "done");
  assert.equal(interviewCardState("done", true, { hideDone: true }), "hidden");
  // A call that fell through is not "booked" — it is a fresh ask, if allowed.
  assert.equal(interviewCardState("fell_through", true), "compose");
  assert.equal(interviewCardState("fell_through", false), "hidden");
  assert.equal(interviewCardState(null, true), "compose");
  assert.equal(interviewCardState(null, false), "hidden");
});

test("proposalsAllPast flags a request only when every proposed time has gone", () => {
  const now = at(0);
  const past = at(-60).toISOString();
  const future = at(60).toISOString();
  assert.equal(proposalsAllPast(past, null, now), true);
  assert.equal(proposalsAllPast(past, past, now), true);
  assert.equal(proposalsAllPast(past, future, now), false);
  assert.equal(proposalsAllPast(future, null, now), false);
  assert.equal(proposalsAllPast(null, null, now), false);
  assert.equal(proposalsAllPast("not a date", null, now), false);
});

test("bookingPrefill never offers a time in the past", () => {
  const now = at(0);
  const past = at(-60).toISOString();
  const future = at(60).toISOString();
  const later = at(120).toISOString();
  assert.equal(bookingPrefill(future, later, now), future);
  assert.equal(bookingPrefill(past, later, now), later);
  assert.equal(bookingPrefill(past, past, now), null);
  assert.equal(bookingPrefill(null, null, now), null);
  assert.equal(bookingPrefill(now.toISOString(), null, now), null);
});

// ---------------------------------------------------------------------------
// Access and routing
// ---------------------------------------------------------------------------

test("a recording is for the two people on the call and admins, nobody else", () => {
  const ids = { hostId: "h", inviteeId: "s" };
  assert.equal(canViewCallRecording({ ...ids, viewerId: "h", superAdmin: false }), true);
  assert.equal(canViewCallRecording({ ...ids, viewerId: "s", superAdmin: false }), true);
  assert.equal(canViewCallRecording({ ...ids, viewerId: "x", superAdmin: true }), true);
  assert.equal(canViewCallRecording({ ...ids, viewerId: "x", superAdmin: false }), false);
});

test("hostCallsHref sends each kind of host back to their own panel", () => {
  const none = { superAdmin: false, mentorPanel: false, investorPanel: false, canInvite: false };
  assert.equal(hostCallsHref({ ...none, superAdmin: true, mentorPanel: true }), "/admin/calls");
  assert.equal(hostCallsHref({ ...none, mentorPanel: true, canInvite: true }), "/mentor/calls");
  assert.equal(hostCallsHref({ ...none, investorPanel: true, canInvite: true }), "/investor/calls");
  assert.equal(hostCallsHref({ ...none, canInvite: true }), "/admin/calls");
  assert.equal(hostCallsHref(none), "/dashboard/calls");
});

// ---------------------------------------------------------------------------
// Email times
// ---------------------------------------------------------------------------

test("formatEasternDateTime names the zone, and knows about daylight saving", () => {
  // The production call: 21:30Z in September is 5:30 PM EDT, the same Saturday.
  assert.equal(
    formatEasternDateTime("2026-09-19T21:30:00Z"),
    "Saturday, September 19, 2026 at 5:30 PM EDT",
  );
  // After the November switch the same UTC hour is an hour earlier, in EST.
  assert.equal(
    formatEasternDateTime("2026-12-05T21:30:00Z"),
    "Saturday, December 5, 2026 at 4:30 PM EST",
  );
  // Late UTC evening is still the previous day in New York — the bug the UTC
  // string caused in reverse for anyone reading it literally.
  assert.equal(
    formatEasternDateTime("2026-09-20T02:00:00Z"),
    "Saturday, September 19, 2026 at 10:00 PM EDT",
  );
  assert.equal(formatEasternDateTime("nope"), null);
});
