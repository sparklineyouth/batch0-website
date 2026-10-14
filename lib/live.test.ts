import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canSeeRoster,
  joinState,
  inviteEndsAt,
  normalizeQuestion,
  MAX_QUESTION_LENGTH,
  JOIN_OPENS_MINUTES_BEFORE,
  JOIN_CLOSES_MINUTES_AFTER,
  DEFAULT_EVENT_MINUTES,
  CALL_STAFF_OPENS_MINUTES_BEFORE,
  GO_LIVE_OPENS_MINUTES_BEFORE,
  ROOM_HARD_CLOSE_MINUTES_AFTER,
  callRoomAccess,
  mayEndCall,
  mayEndWebinar,
  roomAccess,
  roomIsOpen,
  roomWindow,
  eventLiveStatus,
  webinarHasBegun,
  callStaffIds,
  isCallCounterpart,
  isOnCall,
  isStaffOnCall,
  joinNames,
  normalizeCohostIds,
  sameRoomState,
  shouldClaimPrimary,
  shouldStampLiveStart,
  staffNames,
  type CallInvite,
  type LiveRoomState,
  type LiveRole,
  type RoomAccess,
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
    cohosts: [],
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
// Who is on a call (migration 0092: one student, any number of staff)
// ---------------------------------------------------------------------------

const PANEL = {
  hostId: "host",
  inviteeId: "student",
  cohosts: [{ id: "mentor" }, { id: "investor" }],
};

test("everyone on the call is on it; nobody else is, admins included", () => {
  for (const id of ["host", "student", "mentor", "investor"]) {
    assert.equal(isOnCall(PANEL, id), true, id);
  }
  // An admin reading the safeguarding list is not on the call, and the join,
  // calendar and recording gates all ask this — so they cannot walk in.
  assert.equal(isOnCall(PANEL, "an-admin"), false);
  assert.equal(isOnCall(PANEL, ""), false);
});

test("the staff side is the host and the co-hosts, never the student", () => {
  assert.deepEqual(callStaffIds(PANEL), ["host", "mentor", "investor"]);
  assert.equal(isStaffOnCall(PANEL, "host"), true);
  assert.equal(isStaffOnCall(PANEL, "investor"), true);
  // The student may join and End call, but never cancels, records or answers
  // for the team.
  assert.equal(isStaffOnCall(PANEL, "student"), false);
  assert.equal(isStaffOnCall(PANEL, "stranger"), false);
});

test("a call with no co-hosts is the plain 1:1 it always was", () => {
  const plain = { hostId: "host", inviteeId: "student", cohosts: [] };
  assert.deepEqual(callStaffIds(plain), ["host"]);
  assert.equal(isOnCall(plain, "host"), true);
  assert.equal(isOnCall(plain, "student"), true);
  assert.equal(isOnCall(plain, "mentor"), false);
});

test("co-host picks are deduplicated and never repeat the host or the student", () => {
  const parties = { hostId: "host", inviteeId: "student" };
  assert.deepEqual(
    normalizeCohostIds(["m1", "host", "m1", "student", "v1", "", null, 7], parties),
    ["m1", "v1"],
  );
  assert.deepEqual(normalizeCohostIds(undefined, parties), []);
  assert.deepEqual(normalizeCohostIds([], parties), []);
});

test("End call's counterpart: the student for staff, any staff for the student", () => {
  const staff = callStaffIds(PANEL); // host, mentor, investor
  // A co-host in the room with the host is the team waiting for the
  // student — not the call having happened. Only the student counts.
  assert.equal(isCallCounterpart(staff, "host", "mentor"), false);
  assert.equal(isCallCounterpart(staff, "mentor", "host"), false);
  assert.equal(isCallCounterpart(staff, "investor", "mentor"), false);
  assert.equal(isCallCounterpart(staff, "host", "student"), true);
  assert.equal(isCallCounterpart(staff, "investor", "student"), true);
  // The student has met the call once anyone from the team is there.
  assert.equal(isCallCounterpart(staff, "student", "host"), true);
  assert.equal(isCallCounterpart(staff, "student", "investor"), true);
  // Never yourself, never nobody.
  assert.equal(isCallCounterpart(staff, "host", "host"), false);
  assert.equal(isCallCounterpart(staff, "student", ""), false);
  // A plain 1:1 is unchanged: the other person is always the other side.
  assert.equal(isCallCounterpart(["host"], "host", "student"), true);
  assert.equal(isCallCounterpart(["host"], "student", "host"), true);
});

test("a call's team reads host first, then co-hosts in the order added", () => {
  const invite = {
    hostName: "Priya",
    cohosts: [
      { id: "m1", name: "Ben", role: "mentor" },
      { id: "v1", name: "Cy", role: "investor" },
    ],
  };
  assert.deepEqual(staffNames(invite), ["Priya", "Ben", "Cy"]);
  assert.equal(joinNames(staffNames(invite)), "Priya, Ben and Cy");
  assert.equal(joinNames(staffNames({ hostName: "Priya", cohosts: [] })), "Priya");
  assert.equal(joinNames(["Priya", "Ben"]), "Priya and Ben");
  assert.equal(joinNames([]), "");
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
// Room access — the per-role gate every server path shares
// ---------------------------------------------------------------------------
//
// START is 18:00, END 19:00. The viewer window is 17:45–19:30, extended while
// a host is present up to the hard stop at 22:00. The host window is
// 17:00–22:00 whatever End says.

function viewer(
  minutes: number,
  opts: {
    liveEndedAt?: string | null;
    liveStartedAt?: string | null;
    hostPresent?: boolean;
    endsAt?: Date | null;
  } = {},
): RoomAccess {
  return roomAccess({
    startsAt: START,
    endsAt: opts.endsAt === undefined ? END : opts.endsAt,
    liveStartedAt: opts.liveStartedAt ?? null,
    liveEndedAt: opts.liveEndedAt ?? null,
    isHost: false,
    hostPresent: opts.hostPresent ?? false,
    now: at(minutes),
  });
}

function host(minutes: number, liveEndedAt: string | null = null): RoomAccess {
  return roomAccess({
    startsAt: START,
    endsAt: END,
    liveEndedAt,
    isHost: true,
    hostPresent: false,
    now: at(minutes),
  });
}

test("the window constants and instants", () => {
  assert.equal(ROOM_HARD_CLOSE_MINUTES_AFTER, 180);
  assert.equal(GO_LIVE_OPENS_MINUTES_BEFORE, 60);
  const w = roomWindow(START, END);
  assert.equal(w.goLiveOpensAt, at(-60).getTime());
  assert.equal(w.viewerOpensAt, at(-15).getTime());
  assert.equal(w.viewerClosesAt, at(90).getTime());
  assert.equal(w.hardCloseAt, at(240).getTime());
});

test("a webinar has begun at its start, or earlier once a host went live", () => {
  assert.equal(webinarHasBegun(START, null, at(-50).getTime()), false);
  assert.equal(webinarHasBegun(START, null, at(-1).getTime()), false);
  assert.equal(webinarHasBegun(START, null, at(0).getTime()), true);
  assert.equal(webinarHasBegun(START, null, at(30).getTime()), true);
  assert.equal(
    webinarHasBegun(START, at(-10).toISOString(), at(-5).getTime()),
    true,
  );
});

test("a viewer: early before start-15m, open at start-15m, live after the start", () => {
  assert.equal(viewer(-16), "early");
  assert.equal(viewer(-JOIN_OPENS_MINUTES_BEFORE), "open");
  assert.equal(viewer(-1), "open");
  assert.equal(viewer(0), "live");
  assert.equal(viewer(30), "live");
});

test("a viewer may come in early once a host has gone live", () => {
  const wentLive = at(-50).toISOString();
  assert.equal(viewer(-49, { liveStartedAt: wentLive }), "open");
  assert.equal(viewer(-16, { liveStartedAt: wentLive }), "open");
  assert.equal(viewer(5, { liveStartedAt: wentLive }), "live");
  // Going live early widens the start, not the end.
  assert.equal(viewer(91, { liveStartedAt: wentLive }), "closed");
  // And End still wins.
  assert.equal(
    viewer(-60, { liveStartedAt: wentLive, liveEndedAt: at(-61).toISOString() }),
    "ended",
  );
});

// The rehearsal bug: a host opening the room on Tuesday for a Thursday
// webinar stamped live_started_at, which let students into an empty room for
// two days and offered an End that cancelled the real webinar.
function stamp(
  minutes: number,
  opts: {
    liveStartedAt?: string | null;
    liveEndedAt?: string | null;
    liveMode?: string;
  } = {},
): boolean {
  return shouldStampLiveStart({
    startsAt: START,
    endsAt: END,
    liveStartedAt: opts.liveStartedAt ?? null,
    liveEndedAt: opts.liveEndedAt ?? null,
    liveMode: opts.liveMode ?? "hosted",
    now: at(minutes),
  });
}

test("a host in the room goes live only inside the go-live window", () => {
  assert.equal(stamp(-2 * 24 * 60), false, "two days early is a rehearsal");
  assert.equal(stamp(-61), false);
  assert.equal(stamp(-GO_LIVE_OPENS_MINUTES_BEFORE), true, "the boundary is inside");
  assert.equal(stamp(-20), true);
  assert.equal(stamp(30), true);
  assert.equal(stamp(240), true);
  assert.equal(stamp(241), false, "past the hard close");
});

test("going live stamps once: not over a stamp, not after End, never a premiere", () => {
  assert.equal(stamp(-20, { liveStartedAt: at(-30).toISOString() }), false);
  assert.equal(stamp(30, { liveEndedAt: at(20).toISOString() }), false);
  assert.equal(stamp(-20, { liveMode: "premiere" }), false);
});

test("a rehearsal neither lets viewers in nor offers End; the go-live window does", () => {
  // Rehearsing at start-2d: nothing stamped, so the room stays shut to
  // viewers and End stays off.
  assert.equal(stamp(-2 * 24 * 60), false);
  assert.equal(viewer(-2 * 24 * 60), "early");
  assert.equal(mayEnd(-2 * 24 * 60, { isStaff: true }), false);
  // Still there at start-60m: the next heartbeat stamps, and both open.
  const wentLive = at(-60).toISOString();
  assert.equal(viewer(-59, { liveStartedAt: wentLive }), "open");
  assert.equal(mayEnd(-59, { isStaff: true }, { liveStartedAt: wentLive }), true);
});

test("a viewer is refused ('ended') inside the window once a host pressed End", () => {
  const ended = at(40).toISOString();
  assert.equal(viewer(41, { liveEndedAt: ended }), "ended");
  assert.equal(viewer(41, { liveEndedAt: ended, hostPresent: true }), "ended");
});

test("a viewer past end+30m: closed with no host, still live while a host is present", () => {
  assert.equal(viewer(60 + JOIN_CLOSES_MINUTES_AFTER), "live", "the boundary itself is inside");
  assert.equal(viewer(91), "closed");
  assert.equal(viewer(105, { hostPresent: true }), "live");
});

test("the extension stops at the hard close, host or no host", () => {
  assert.equal(viewer(240, { hostPresent: true }), "live");
  assert.equal(viewer(241, { hostPresent: true }), "closed");
});

test("a room with no end time is assumed to run the default length", () => {
  assert.equal(viewer(DEFAULT_EVENT_MINUTES + 30, { endsAt: null }), "live");
  assert.equal(viewer(DEFAULT_EVENT_MINUTES + 31, { endsAt: null }), "closed");
});

test("a host may open the room any time before the hard close — never 'early'", () => {
  assert.equal(host(-7 * 24 * 60), "open");
  assert.equal(host(-61), "open");
  assert.equal(host(-1), "open");
  assert.equal(host(5), "live");
});

test("a host keeps the room after End, so staff can reach the ended screen and Reopen", () => {
  const ended = at(40).toISOString();
  assert.equal(host(41, ended), "live");
  assert.equal(host(200, ended), "live");
});

test("a host's room closes at end+3h", () => {
  assert.equal(host(240), "live");
  assert.equal(host(241), "closed");
});

test("only open and live let anyone in", () => {
  assert.equal(roomIsOpen("open"), true);
  assert.equal(roomIsOpen("live"), true);
  assert.equal(roomIsOpen("early"), false);
  assert.equal(roomIsOpen("ended"), false);
  assert.equal(roomIsOpen("closed"), false);
});

// ---------------------------------------------------------------------------
// eventLiveStatus — what a list shows
// ---------------------------------------------------------------------------

function listed(minutes: number, liveEndedAt: string | null = null) {
  return eventLiveStatus({ startsAt: START, endsAt: END, liveEndedAt }, at(minutes));
}

test("a list follows the audience window when nobody has ended it", () => {
  assert.equal(listed(-16), "upcoming");
  assert.equal(listed(-10), "open");
  assert.equal(listed(10), "live");
  assert.equal(listed(91), "past");
});

test("an ended webinar reads 'ended' inside the join window, not Live / Join", () => {
  // The bug: ended at 18:40, still "Live now" until 19:30.
  assert.equal(listed(45, at(40).toISOString()), "ended");
  assert.equal(listed(120, at(40).toISOString()), "ended");
});

test("a list offers Join early once a host went live early, as the room does", () => {
  const wentLive = at(-40).toISOString();
  const early = (minutes: number, liveEndedAt: string | null = null) =>
    eventLiveStatus(
      { startsAt: START, endsAt: END, liveStartedAt: wentLive, liveEndedAt },
      at(minutes),
    );
  assert.equal(early(-39), "open");
  assert.equal(viewer(-39, { liveStartedAt: wentLive }), "open", "the room agrees");
  assert.equal(early(-10), "open");
  assert.equal(early(10), "live");
  assert.equal(early(91), "past", "going live early widens the start, not the end");
  assert.equal(early(-30, at(-35).toISOString()), "ended");
  assert.equal(listed(-39), "upcoming", "without the stamp: the schedule's answer");
});

test("an event with no end time lists with the default length", () => {
  const s = eventLiveStatus(
    { startsAt: START, endsAt: null, liveEndedAt: null },
    at(DEFAULT_EVENT_MINUTES + 31),
  );
  assert.equal(s, "past");
});

// ---------------------------------------------------------------------------
// End for everyone, and the primary seat
// ---------------------------------------------------------------------------

function mayEnd(
  minutes: number,
  who: { isStaff?: boolean; isSpeaker?: boolean; staffPresent?: boolean },
  stamps: { liveStartedAt?: string | null; liveEndedAt?: string | null } = {},
): boolean {
  return mayEndWebinar({
    isStaff: !!who.isStaff,
    isSpeaker: !!who.isSpeaker,
    staffPresent: !!who.staffPresent,
    startsAt: START,
    endsAt: END,
    liveStartedAt: stamps.liveStartedAt ?? null,
    liveEndedAt: stamps.liveEndedAt ?? null,
    now: at(minutes),
  });
}

test("End exists once a host went live or the start passed, up to the hard close", () => {
  assert.equal(mayEnd(-30, { isStaff: true }), false, "not before it began");
  assert.equal(
    mayEnd(-30, { isStaff: true }, { liveStartedAt: at(-40).toISOString() }),
    true,
    "a host going live early is the start",
  );
  assert.equal(mayEnd(0, { isStaff: true }), true);
  assert.equal(mayEnd(240, { isStaff: true }), true);
  assert.equal(mayEnd(241, { isStaff: true }), false);
  assert.equal(
    mayEnd(10, { isStaff: true }, { liveEndedAt: at(5).toISOString() }),
    false,
    "already ended",
  );
});

test("End: staff always; a speaker only with no staff host present; a viewer never", () => {
  assert.equal(mayEnd(10, { isStaff: true, staffPresent: true }), true);
  assert.equal(mayEnd(10, { isSpeaker: true, staffPresent: false }), true);
  assert.equal(mayEnd(10, { isSpeaker: true, staffPresent: true }), false);
  assert.equal(mayEnd(10, {}), false);
});

test("the primary seat: claimed when free or its holder is gone, never on a guess", () => {
  assert.equal(shouldClaimPrimary({ current: null, selfId: "a", present: null }), true);
  assert.equal(shouldClaimPrimary({ current: null, selfId: "a", present: [] }), true);
  assert.equal(shouldClaimPrimary({ current: "a", selfId: "a", present: [] }), false);
  assert.equal(shouldClaimPrimary({ current: "b", selfId: "a", present: ["b"] }), false);
  assert.equal(shouldClaimPrimary({ current: "b", selfId: "a", present: ["a"] }), true);
  assert.equal(
    shouldClaimPrimary({ current: "b", selfId: "a", present: null }),
    false,
    "presence unreadable: keep the holder",
  );
});

// ---------------------------------------------------------------------------
// 1:1 room access
// ---------------------------------------------------------------------------

function call(
  minutes: number,
  status: string,
  isStaff: boolean,
  durationMinutes = 30,
) {
  return callRoomAccess({ status, startsAt: START, durationMinutes, isStaff, now: at(minutes) });
}

test("an unanswered invite is joinable exactly like an accepted one", () => {
  for (const status of ["invited", "accepted"]) {
    assert.equal(call(-10, status, false), "open", status);
    assert.equal(call(10, status, false), "live", status);
    assert.equal(call(10, status, true), "live", status);
  }
});

test("declined, cancelled and completed calls are shut; an unknown status too", () => {
  assert.equal(call(10, "declined", true), "declined");
  assert.equal(call(10, "cancelled", false), "cancelled");
  assert.equal(call(10, "completed", false), "completed");
  assert.equal(call(10, "something-new", true), "cancelled");
});

test("the staff side may come in an hour early, the student 15 minutes early", () => {
  assert.equal(CALL_STAFF_OPENS_MINUTES_BEFORE, 60);
  assert.equal(call(-60, "accepted", true), "open");
  assert.equal(call(-61, "accepted", true), "early");
  assert.equal(call(-15, "accepted", false), "open");
  assert.equal(call(-16, "accepted", false), "early");
});

test("a call that runs long is not cut off at end+30m; it closes at end+3h", () => {
  // 30-minute call: end at +30, hard stop at +210.
  assert.equal(call(30 + JOIN_CLOSES_MINUTES_AFTER + 1, "accepted", false), "live");
  assert.equal(call(30 + ROOM_HARD_CLOSE_MINUTES_AFTER, "accepted", true), "live");
  assert.equal(call(30 + ROOM_HARD_CLOSE_MINUTES_AFTER + 1, "accepted", true), "closed");
});

test("End call: from the start, while the call is open", () => {
  const end = (minutes: number, status: string) =>
    mayEndCall({ status, startsAt: START, now: at(minutes) });
  assert.equal(end(-1, "accepted"), false);
  assert.equal(end(0, "accepted"), true);
  assert.equal(end(5, "invited"), true);
  assert.equal(end(5, "completed"), false);
  assert.equal(end(5, "cancelled"), false);
});

// ---------------------------------------------------------------------------
// Room state equality
// ---------------------------------------------------------------------------

test("room state: equal by value, recording included", () => {
  const base: LiveRoomState = {
    primaryId: "a",
    liveStartedAt: "t1",
    liveEndedAt: null,
    canEnd: true,
    recording: { sessionId: "s", byUserId: "a", byName: "Ana", startedAt: "t2" },
  };
  assert.equal(sameRoomState(base, { ...base, recording: { ...base.recording! } }), true);
  assert.equal(sameRoomState(base, { ...base, primaryId: "b" }), false);
  assert.equal(sameRoomState(base, { ...base, canEnd: false }), false);
  assert.equal(sameRoomState(base, { ...base, recording: null }), false);
  assert.equal(sameRoomState(null, null), true);
  assert.equal(sameRoomState(base, null), false);
});
