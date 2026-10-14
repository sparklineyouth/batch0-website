import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoCompleteRange,
  AUTO_COMPLETE_LOOKBACK_DAYS,
  bookingPrefill,
  CALL_HARD_CLOSE_MINUTES_AFTER,
  CALL_STAFF_OPENS_MINUTES_BEFORE,
  CALL_STUDENT_OPENS_MINUTES_BEFORE,
  callBadge,
  callDurationProblem,
  callEndsAt,
  callPhase,
  callStartProblem,
  callWindow,
  canAddCallCohosts,
  canCancelCall,
  canDeclineCall,
  canEditCall,
  canMarkCallCompleted,
  canRequestTeamCall,
  canUploadCallRecording,
  canViewCallRecording,
  cohostsToAdd,
  formatEasternDateTime,
  hostCallsHref,
  isPastPhase,
  isRoomOpenPhase,
  mayHaveCallRecording,
  proposalsAllPast,
  RECORDING_UPLOAD_GRACE_MINUTES,
  requestCardState,
  shouldAutoComplete,
  splitCalls,
  START_GRACE_MINUTES,
  startOfMinute,
  type CallPhase,
  type CallTiming,
} from "./call-lifecycle.ts";
import { MAX_CALL_COHOSTS, type CallInviteStatus } from "./live.ts";

// Run with `npm test`. Every assertion pins `now`: the answer depends on the
// clock and nothing else.

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

// The last minute the room is open, and the first minute after.
const LAST_OPEN = DURATION + CALL_HARD_CLOSE_MINUTES_AFTER;
const FIRST_CLOSED = LAST_OPEN + 1;
const STUDENT_OPENS = -CALL_STUDENT_OPENS_MINUTES_BEFORE;
const STAFF_OPENS = -CALL_STAFF_OPENS_MINUTES_BEFORE;

// ---------------------------------------------------------------------------
// callPhase
// ---------------------------------------------------------------------------

test("the windows match the room's access rules", () => {
  assert.equal(CALL_STAFF_OPENS_MINUTES_BEFORE, 60);
  assert.equal(CALL_STUDENT_OPENS_MINUTES_BEFORE, 15);
  assert.equal(CALL_HARD_CLOSE_MINUTES_AFTER, 180);
  const w = callWindow(call("invited"), "staff");
  assert.equal(w.opensAt, at(-60).getTime());
  assert.equal(w.end, at(DURATION).getTime());
  assert.equal(w.hardCloseAt, at(DURATION + 180).getTime());
  assert.equal(callWindow(call("invited")).opensAt, at(-15).getTime(), "student by default");
});

test("an invited call is joinable without anyone accepting it", () => {
  const c = call("invited");
  assert.equal(callPhase(c, at(STUDENT_OPENS - 1)), "needs_answer");
  assert.equal(callPhase(c, at(STUDENT_OPENS)), "joinable");
  assert.equal(callPhase(c, at(-1)), "joinable");
  assert.equal(callPhase(c, at(0)), "live");
  assert.equal(isRoomOpenPhase(callPhase(c, at(5))), true);
});

test("an accepted (legacy) call walks the same windows", () => {
  const c = call("accepted");
  assert.equal(callPhase(c, at(STUDENT_OPENS - 1)), "upcoming");
  assert.equal(callPhase(c, at(STUDENT_OPENS)), "joinable");
  assert.equal(callPhase(c, at(0)), "live");
  assert.equal(callPhase(c, at(LAST_OPEN)), "live");
  assert.equal(callPhase(c, at(FIRST_CLOSED)), "ended");
});

test("the staff side's room opens an hour early, the student's fifteen minutes", () => {
  for (const status of ["invited", "accepted"] as const) {
    const c = call(status);
    assert.equal(isRoomOpenPhase(callPhase(c, at(STAFF_OPENS - 1), "staff")), false);
    assert.equal(callPhase(c, at(STAFF_OPENS), "staff"), "joinable");
    assert.equal(callPhase(c, at(-30), "staff"), "joinable");
    assert.equal(isRoomOpenPhase(callPhase(c, at(-30), "student")), false);
    assert.equal(callPhase(c, at(STUDENT_OPENS), "student"), "joinable");
  }
});

test("a call running over stays open until the hard close, not end + 30", () => {
  const c = call("invited");
  assert.equal(callPhase(c, at(DURATION + 31)), "live");
  assert.equal(callPhase(c, at(DURATION + 120), "staff"), "live");
  assert.equal(callPhase(c, at(LAST_OPEN)), "live");
  assert.equal(callPhase(c, at(FIRST_CLOSED)), "ended");
  assert.equal(callPhase(c, at(FIRST_CLOSED), "staff"), "ended", "both sides agree it is over");
});

test("decisions are final whatever the clock says", () => {
  for (const now of [at(-600), at(0), at(600)]) {
    for (const side of ["staff", "student"] as const) {
      assert.equal(callPhase(call("declined"), now, side), "declined");
      assert.equal(callPhase(call("cancelled"), now, side), "cancelled");
      assert.equal(callPhase(call("completed"), now, side), "completed");
    }
  }
});

test("an unrecognised status is treated as cancelled, never as joinable", () => {
  const weird = call("archived" as CallInviteStatus);
  assert.equal(callPhase(weird, at(0)), "cancelled");
  assert.equal(canCancelCall(weird, at(0)), false);
  assert.equal(canDeclineCall(weird, at(-600)), false);
  assert.equal(canMarkCallCompleted(weird, at(0)), false);
});

test("duration moves the end and the hard close", () => {
  const long = call("accepted", { durationMinutes: 240 });
  assert.equal(callPhase(long, at(240 + CALL_HARD_CLOSE_MINUTES_AFTER)), "live");
  assert.equal(callPhase(long, at(240 + CALL_HARD_CLOSE_MINUTES_AFTER + 1)), "ended");
  assert.equal(callEndsAt(START, 45).toISOString(), "2026-09-19T22:15:00.000Z");
});

// ---------------------------------------------------------------------------
// What each side may do
// ---------------------------------------------------------------------------

test("the student may decline a booked call until the room closes", () => {
  for (const status of ["invited", "accepted"] as const) {
    const c = call(status);
    assert.equal(canDeclineCall(c, at(-60 * 24)), true, status);
    assert.equal(canDeclineCall(c, at(5)), true, "can't make it, even once it started");
    assert.equal(canDeclineCall(c, at(FIRST_CLOSED)), false, status);
  }
  for (const s of ["declined", "cancelled", "completed"] as const) {
    assert.equal(canDeclineCall(call(s), at(-600)), false, s);
  }
});

test("the staff side may cancel, edit and add people until the call is over", () => {
  for (const status of ["invited", "accepted"] as const) {
    for (const m of [-60 * 24, STAFF_OPENS, 0, LAST_OPEN]) {
      assert.equal(canCancelCall(call(status), at(m)), true, `${status} cancel at ${m}`);
      assert.equal(canEditCall(call(status), at(m)), true, `${status} edit at ${m}`);
      assert.equal(canAddCallCohosts(call(status), at(m)), true, `${status} add at ${m}`);
    }
    assert.equal(canCancelCall(call(status), at(FIRST_CLOSED)), false);
    assert.equal(canEditCall(call(status), at(FIRST_CLOSED)), false);
    assert.equal(canAddCallCohosts(call(status), at(FIRST_CLOSED)), false);
  }
  for (const s of ["cancelled", "declined", "completed"] as const) {
    assert.equal(canCancelCall(call(s), at(-600)), false, `${s}: no second refund`);
    assert.equal(canEditCall(call(s), at(-600)), false, s);
    assert.equal(canAddCallCohosts(call(s), at(0)), false, s);
  }
});

test("every Upcoming card can take more people, and no Past one", () => {
  const statuses: CallInviteStatus[] = ["invited", "accepted", "declined", "cancelled", "completed"];
  const offsets = [-60 * 24 * 7, STAFF_OPENS - 1, STAFF_OPENS, 0, LAST_OPEN, FIRST_CLOSED, 60 * 24 * 7];
  for (const s of statuses) {
    for (const m of offsets) {
      const c = call(s);
      const { upcoming } = splitCalls([c], at(m));
      assert.equal(canAddCallCohosts(c, at(m)), upcoming.length === 1, `${s} at ${m}`);
    }
  }
});

test("End call completes a booked call once the room has opened", () => {
  assert.equal(canMarkCallCompleted(call("invited"), at(STAFF_OPENS - 1)), false);
  assert.equal(canMarkCallCompleted(call("invited"), at(STAFF_OPENS)), true);
  assert.equal(canMarkCallCompleted(call("invited"), at(0)), true);
  assert.equal(canMarkCallCompleted(call("accepted"), at(FIRST_CLOSED + 60)), true);
  assert.equal(canMarkCallCompleted(call("cancelled"), at(5)), false);
  assert.equal(canMarkCallCompleted(call("completed"), at(5)), false);
});

test("recording uploads run from the staff room opening to a grace past the hard close", () => {
  for (const s of ["invited", "accepted", "completed", "cancelled"] as const) {
    const c = call(s);
    assert.equal(canUploadCallRecording(c, at(STAFF_OPENS - 1)), false, s);
    assert.equal(canUploadCallRecording(c, at(STAFF_OPENS)), true, s);
    assert.equal(canUploadCallRecording(c, at(LAST_OPEN + RECORDING_UPLOAD_GRACE_MINUTES)), true, s);
    assert.equal(
      canUploadCallRecording(c, at(LAST_OPEN + RECORDING_UPLOAD_GRACE_MINUTES + 1)),
      false,
      s,
    );
  }
  assert.equal(canUploadCallRecording(call("declined"), at(10)), false);
});

test("a call may have a recording once its room could have opened", () => {
  assert.equal(mayHaveCallRecording(call("invited"), at(STAFF_OPENS - 1)), false);
  assert.equal(mayHaveCallRecording(call("invited"), at(STAFF_OPENS)), true);
  assert.equal(mayHaveCallRecording(call("accepted"), at(FIRST_CLOSED)), true);
  assert.equal(mayHaveCallRecording(call("completed"), at(-600)), true);
  assert.equal(mayHaveCallRecording(call("declined"), at(FIRST_CLOSED)), false);
});

test("a cancelled call is looked up only when it was cancelled while the room was open", () => {
  const cancelledAt = (minutes: number) => call("cancelled", { updatedAt: at(minutes).toISOString() });
  assert.equal(mayHaveCallRecording(cancelledAt(5), at(FIRST_CLOSED)), true);
  assert.equal(mayHaveCallRecording(cancelledAt(STAFF_OPENS), at(FIRST_CLOSED)), true);
  assert.equal(mayHaveCallRecording(cancelledAt(LAST_OPEN), at(FIRST_CLOSED + 60)), true);
  assert.equal(mayHaveCallRecording(cancelledAt(-3 * 24 * 60), at(FIRST_CLOSED)), false);
  assert.equal(mayHaveCallRecording(cancelledAt(STAFF_OPENS - 1), at(FIRST_CLOSED)), false);
  // Room not open yet: nothing to find, whatever the timestamp.
  assert.equal(mayHaveCallRecording(cancelledAt(STAFF_OPENS), at(STAFF_OPENS - 1)), false);
  // No usable timestamp: could the room have opened yet?
  assert.equal(mayHaveCallRecording(call("cancelled", { updatedAt: "nope" }), at(FIRST_CLOSED)), true);
  assert.equal(mayHaveCallRecording(call("cancelled"), at(STAFF_OPENS - 1)), false);
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

test("the sweep completes booked calls only after the hard close", () => {
  for (const s of ["invited", "accepted"] as const) {
    assert.equal(shouldAutoComplete(call(s), at(DURATION + 31)), false, `${s}: running over`);
    assert.equal(shouldAutoComplete(call(s), at(LAST_OPEN)), false, s);
    assert.equal(shouldAutoComplete(call(s), at(FIRST_CLOSED)), true, s);
  }
  for (const s of ["completed", "cancelled", "declined"] as const) {
    assert.equal(shouldAutoComplete(call(s), at(FIRST_CLOSED)), false, s);
  }
});

test("the sweep's prefilter never excludes a recent call that is due", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const { from, to } = autoCompleteRange(now);
  assert.equal(now.getTime() - from.getTime(), AUTO_COMPLETE_LOOKBACK_DAYS * 24 * 60 * MINUTE);
  for (const duration of [5, 30, 240]) {
    // The latest start for which this call is already due.
    const latestDueStart =
      now.getTime() - (duration + CALL_HARD_CLOSE_MINUTES_AFTER) * MINUTE - 1;
    const c = call("invited", {
      durationMinutes: duration,
      startsAt: new Date(latestDueStart).toISOString(),
    });
    assert.equal(shouldAutoComplete(c, now), true, `duration ${duration}`);
    assert.ok(latestDueStart <= to.getTime(), `duration ${duration} passes the prefilter`);
    assert.ok(latestDueStart >= from.getTime());
  }
});

// ---------------------------------------------------------------------------
// Booking input
// ---------------------------------------------------------------------------

test("a call may start a few minutes back (Start call now), never earlier", () => {
  const now = at(0);
  assert.equal(callStartProblem(at(60), now), null);
  assert.equal(callStartProblem(now, now), null);
  assert.equal(callStartProblem(at(-START_GRACE_MINUTES), now), null);
  assert.equal(callStartProblem(at(-START_GRACE_MINUTES - 1), now), "That time is in the past.");
  assert.equal(callStartProblem(new Date("nope"), now), "That time isn't valid.");
});

test("startOfMinute floors to the minute, so a started call is inside its own window", () => {
  const now = new Date("2026-09-19T21:30:42.123Z");
  assert.equal(startOfMinute(now).toISOString(), "2026-09-19T21:30:00.000Z");
  const started = call("invited", { startsAt: startOfMinute(now).toISOString() });
  assert.equal(callPhase(started, now, "student"), "live");
  assert.equal(callPhase(started, now, "staff"), "live");
  assert.equal(callStartProblem(startOfMinute(now), now), null);
});

test("durations are held to 5–240 minutes", () => {
  assert.equal(callDurationProblem(30), null);
  assert.equal(callDurationProblem(5), null);
  assert.equal(callDurationProblem(240), null);
  assert.match(callDurationProblem(4) ?? "", /between 5 and 240/);
  assert.match(callDurationProblem(241) ?? "", /between 5 and 240/);
  assert.ok(callDurationProblem(Number.NaN));
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
    mk("soon", "invited", 60),
    mk("live", "invited", -5),
    mk("overrun", "invited", -120),
    mk("oldInvite", "invited", -60 * 24),
    mk("oldAccepted", "accepted", -60 * 24 * 7),
    mk("cancelledFuture", "cancelled", 60 * 24),
    mk("done", "completed", -60 * 5),
  ];
  const { upcoming, past } = splitCalls(calls, now);
  assert.deepEqual(upcoming.map((c) => c.id), ["overrun", "live", "soon", "far"]);
  assert.deepEqual(past.map((c) => c.id), ["cancelledFuture", "done", "oldInvite", "oldAccepted"]);
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
    "upcoming",
    "joinable",
    "live",
    "ended",
    "completed",
    "declined",
    "cancelled",
  ];
  for (const p of ALL) assert.ok(callBadge(p).length > 0, p);
  assert.deepEqual(ALL.filter(isPastPhase), ["ended", "completed", "declined", "cancelled"]);
  assert.deepEqual(ALL.filter(isRoomOpenPhase), ["joinable", "live"]);
  // No accept step: an invite and a legacy acceptance read the same.
  assert.equal(callBadge("needs_answer"), callBadge("upcoming"));
  assert.equal(callBadge("ended"), "ended");
});

// ---------------------------------------------------------------------------
// Request a 1:1
// ---------------------------------------------------------------------------

test("requestCardState: waiting, booked (hidden: it is in the list), or the ask", () => {
  const scheduled = (c: CallTiming | null) => ({ status: "scheduled", call: c });
  assert.equal(requestCardState(null, true, at(0)), "compose");
  assert.equal(requestCardState(null, false, at(0)), "hidden");
  assert.equal(requestCardState({ status: "requested", call: null }, false, at(0)), "requested");
  assert.equal(requestCardState(scheduled(call("invited")), true, at(-60)), "hidden");
  assert.equal(requestCardState(scheduled(call("invited")), true, at(10)), "hidden");
  // Over, or fell through: ask again.
  assert.equal(requestCardState(scheduled(call("invited")), true, at(FIRST_CLOSED)), "compose");
  assert.equal(requestCardState(scheduled(call("completed")), true, at(0)), "compose");
  assert.equal(requestCardState(scheduled(call("cancelled")), true, at(-60)), "compose");
  assert.equal(requestCardState(scheduled(call("declined")), true, at(-60)), "compose");
  assert.equal(requestCardState(scheduled(null), true, at(0)), "compose");
  assert.equal(requestCardState(scheduled(null), false, at(0)), "hidden");
});

test("canRequestTeamCall: any enrolled student, whenever they want; never staff", () => {
  assert.equal(canRequestTeamCall({ enrolled: true, staff: false }), true);
  assert.equal(canRequestTeamCall({ enrolled: false, staff: false }), false);
  assert.equal(canRequestTeamCall({ enrolled: true, staff: true }), false);
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

test("a recording is for the people on the call and admins, nobody else", () => {
  const ids = { hostId: "h", inviteeId: "s", cohostIds: ["m"] };
  assert.equal(canViewCallRecording({ ...ids, viewerId: "h", superAdmin: false }), true);
  assert.equal(canViewCallRecording({ ...ids, viewerId: "s", superAdmin: false }), true);
  assert.equal(canViewCallRecording({ ...ids, viewerId: "m", superAdmin: false }), true);
  assert.equal(canViewCallRecording({ ...ids, viewerId: "x", superAdmin: true }), true);
  assert.equal(canViewCallRecording({ ...ids, viewerId: "x", superAdmin: false }), false);
});

test("cohostsToAdd keeps only people who are new to the call", () => {
  const onCall = { hostId: "h", inviteeId: "s", cohosts: [{ id: "m" }] };
  assert.deepEqual(cohostsToAdd(["a", "h", "s", "m", "a", "", null, 7, "b"], onCall).ids, ["a", "b"]);
  const none = cohostsToAdd(["m", "h"], onCall);
  assert.deepEqual(none.ids, []);
  assert.equal(none.fits, true);
  assert.deepEqual(cohostsToAdd(null, onCall).ids, []);
});

test("cohostsToAdd counts the cap against the call's total, not the request", () => {
  const staffed = (n: number) => ({
    hostId: "h",
    inviteeId: "s",
    cohosts: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })),
  });
  const nearlyFull = staffed(MAX_CALL_COHOSTS - 2);
  assert.equal(cohostsToAdd([], nearlyFull).room, 2);
  assert.equal(cohostsToAdd(["x", "y"], nearlyFull).fits, true);
  assert.equal(cohostsToAdd(["x", "y", "z"], nearlyFull).fits, false);
  const full = staffed(MAX_CALL_COHOSTS);
  assert.equal(cohostsToAdd(["x"], full).fits, false);
  assert.equal(cohostsToAdd(["c3"], full).fits, true);
  const stray = cohostsToAdd([], {
    hostId: "h",
    inviteeId: "s",
    cohosts: [{ id: "h" }, { id: "s" }, { id: "m" }],
  });
  assert.equal(stray.room, MAX_CALL_COHOSTS - 1);
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
  assert.equal(formatEasternDateTime("2026-09-19T21:30:00Z"), "Saturday, September 19, 2026 at 5:30 PM EDT");
  assert.equal(formatEasternDateTime("2026-12-05T21:30:00Z"), "Saturday, December 5, 2026 at 4:30 PM EST");
  assert.equal(formatEasternDateTime("2026-09-20T02:00:00Z"), "Saturday, September 19, 2026 at 10:00 PM EDT");
  assert.equal(formatEasternDateTime("nope"), null);
});
