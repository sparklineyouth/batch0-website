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
  HOST_JOIN_OPENS_MINUTES_BEFORE,
  ROOM_HARD_CLOSE_MINUTES_AFTER,
  roomAccess,
  roomIsOpen,
  roomWindow,
  eventLiveStatus,
  callPhase,
  formatEventTime,
  type CallInvite,
  type LiveRole,
  type RoomAccess,
} from "./live.ts";
import {
  callsHomeFor,
  capabilitiesFrom,
  isLiveRoomPath,
} from "./permissions.ts";

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


// ---------------------------------------------------------------------------
// Room access — the per-role gate every server path shares
// ---------------------------------------------------------------------------
//
// START is 18:00, END 19:00. The viewer window is 17:45–19:30, extended while
// a host is present up to the hard stop at 22:00. The host window is
// 17:00–22:00 whatever End says.

function viewer(
  minutes: number,
  opts: { liveEndedAt?: string | null; hostPresent?: boolean; endsAt?: Date | null } = {},
): RoomAccess {
  return roomAccess({
    startsAt: START,
    endsAt: opts.endsAt === undefined ? END : opts.endsAt,
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

test("the host window is wider than the audience's, and the constants say so", () => {
  assert.equal(HOST_JOIN_OPENS_MINUTES_BEFORE, 60);
  assert.equal(ROOM_HARD_CLOSE_MINUTES_AFTER, 180);
  const w = roomWindow(START, END);
  assert.equal(w.hostOpensAt, at(-60).getTime());
  assert.equal(w.viewerOpensAt, at(-15).getTime());
  assert.equal(w.viewerClosesAt, at(90).getTime());
  assert.equal(w.hardCloseAt, at(240).getTime());
});

test("a viewer: early before start-15m, open at start-15m, live after the start", () => {
  assert.equal(viewer(-16), "early");
  assert.equal(viewer(-JOIN_OPENS_MINUTES_BEFORE), "open");
  assert.equal(viewer(-1), "open");
  assert.equal(viewer(0), "live");
  assert.equal(viewer(30), "live");
});

test("a viewer is refused ('ended') inside the window once a host pressed End", () => {
  const ended = at(40).toISOString();
  assert.equal(viewer(41, { liveEndedAt: ended }), "ended");
  // Even with a host still present — End is terminal for the audience.
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
  // No end: the viewer window closes at start + 60 + 30.
  assert.equal(viewer(DEFAULT_EVENT_MINUTES + 30, { endsAt: null }), "live");
  assert.equal(viewer(DEFAULT_EVENT_MINUTES + 31, { endsAt: null }), "closed");
});

test("a host may open the room an hour early — an admin setting up is not 'early'", () => {
  assert.equal(host(-61), "early");
  assert.equal(host(-60), "open");
  assert.equal(host(-30), "open");
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

test("an event with no end time lists with the default length", () => {
  const s = eventLiveStatus(
    { startsAt: START, endsAt: null, liveEndedAt: null },
    at(DEFAULT_EVENT_MINUTES + 31),
  );
  assert.equal(s, "past");
});

// ---------------------------------------------------------------------------
// callPhase — where a 1:1 stands
// ---------------------------------------------------------------------------

function call(status: CallInvite["status"], minutes: number) {
  return callPhase(
    { status, startsAt: START.toISOString(), durationMinutes: 30 },
    at(minutes),
  );
}

test("an accepted call inside its window is joinable, before it upcoming", () => {
  assert.equal(call("accepted", -16), "upcoming");
  assert.equal(call("accepted", -15), "joinable");
  assert.equal(call("accepted", 10), "joinable");
  // 30-minute call: window closes at start + 30 + 30.
  assert.equal(call("accepted", 60), "joinable");
});

test("an accepted call past start + duration + 30 counts as completed", () => {
  assert.equal(call("accepted", 61), "completed");
});

test("stored terminal statuses pass straight through", () => {
  assert.equal(call("completed", 10), "completed");
  assert.equal(call("cancelled", 10), "cancelled");
  assert.equal(call("declined", 10), "declined");
});

test("an unanswered invite is 'invited', whatever the clock says", () => {
  assert.equal(call("invited", -100), "invited");
  assert.equal(call("invited", 10), "invited");
});

// ---------------------------------------------------------------------------
// Live-room routing (lib/permissions.ts) — the middleware exemption and the
// role-aware Back link. Kept beside the room rules they serve.
// ---------------------------------------------------------------------------

test("only the two room paths are live rooms", () => {
  assert.equal(isLiveRoomPath("/dashboard/events/abc/live"), true);
  assert.equal(isLiveRoomPath("/dashboard/calls/abc/live"), true);
  assert.equal(isLiveRoomPath("/dashboard/events/abc/live/"), true);

  assert.equal(isLiveRoomPath("/dashboard/events"), false);
  assert.equal(isLiveRoomPath("/dashboard/calls"), false);
  assert.equal(isLiveRoomPath("/dashboard/events/abc"), false);
  assert.equal(isLiveRoomPath("/dashboard/events/abc/live/y"), false);
  assert.equal(isLiveRoomPath("/dashboard/events//live"), false);
  assert.equal(isLiveRoomPath("/dashboard/teams/abc/live"), false);
  assert.equal(isLiveRoomPath("/admin/events/abc/live"), false);
});

test("a call owner's Back goes to their own calls page", () => {
  assert.equal(callsHomeFor(capabilitiesFrom("admin", ["*"])), "/admin/calls");
  assert.equal(
    callsHomeFor(capabilitiesFrom("mentor", ["mentor.panel", "calls.invite"])),
    "/mentor/calls",
  );
  assert.equal(
    callsHomeFor(capabilitiesFrom("investor", ["investor.panel", "calls.invite"])),
    "/investor/calls",
  );
  assert.equal(
    callsHomeFor(capabilitiesFrom("student", ["student.dashboard"])),
    "/dashboard/calls",
  );
  // A mentor role with admin-area access to calls sees the admin page.
  assert.equal(
    callsHomeFor(capabilitiesFrom("custom", ["mentor.panel", "calls.invite", "events.manage"])),
    "/admin/calls",
  );
});

// ---------------------------------------------------------------------------
// Server-rendered event times (emails)
// ---------------------------------------------------------------------------

test("an email's event time is Eastern and says so, whatever the server's zone", () => {
  // 22:00 UTC on 27 Sep 2026 is 18:00 EDT. The invite used to print
  // "9/27/2026, 10:00:00 PM" from a UTC server, with no zone.
  const summer = formatEventTime("2026-09-27T22:00:00Z");
  assert.match(summer, /Sep 27, 2026/);
  assert.match(summer, /6:00 PM/);
  assert.match(summer, /EDT$/);
  assert.doesNotMatch(summer, /10:00/);
  // Standard time gets the other label.
  const winter = formatEventTime(new Date("2026-12-06T23:30:00Z"));
  assert.match(winter, /Dec 6, 2026/);
  assert.match(winter, /6:30 PM/);
  assert.match(winter, /EST$/);
  // Plain spaces only — no narrow no-break space before "PM" in a mail body.
  assert.doesNotMatch(summer + winter, /[\u202f\u00a0]/);
});

test("an unparseable time is passed through rather than printed as 'Invalid Date'", () => {
  assert.equal(formatEventTime("not a date"), "not a date");
});
