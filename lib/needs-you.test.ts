import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dueSoon,
  homeNeeds,
  moreDueLabel,
  pickNextCall,
  pickNextEvent,
  pickNextEvents,
  type HomeEventRow,
} from "./needs-you.ts";

const NOW = new Date("2026-10-14T16:00:00Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

function ev(id: string, startMin: number, extra: Partial<HomeEventRow> = {}): HomeEventRow {
  return {
    id,
    title: id,
    starts_at: at(startMin),
    ends_at: at(startMin + 60),
    live_mode: "hosted",
    zoom_url: null,
    live_started_at: null,
    live_ended_at: null,
    ...extra,
  };
}

test("next event: a running one beats an earlier-listed upcoming one", () => {
  const got = pickNextEvent([ev("later", 120), ev("now", -10)], NOW, { preCohort: false });
  assert.equal(got?.id, "now");
  assert.equal(got?.live, true);
  assert.deepEqual(got?.join, { href: "/dashboard/events/now/live", external: false });
});

test("next event: upcoming has no Join until its window opens", () => {
  const far = pickNextEvent([ev("a", 120)], NOW, { preCohort: false });
  assert.equal(far?.join, null);
  assert.equal(far?.href, "/dashboard/events");
  const soon = pickNextEvent([ev("a", 10)], NOW, { preCohort: false });
  assert.deepEqual(soon?.join, { href: "/dashboard/events/a/live", external: false });
});

test("next event: ended and past events are skipped", () => {
  const ended = ev("ended", -10, { live_ended_at: at(-1) });
  const past = ev("past", -300);
  assert.equal(pickNextEvent([ended, past], NOW, { preCohort: false }), null);
});

test("next event: external joins only over https", () => {
  const ok = pickNextEvent([ev("z", 5, { live_mode: "external", zoom_url: "https://zoom.us/j/1" })], NOW, {
    preCohort: false,
  });
  assert.deepEqual(ok?.join, { href: "https://zoom.us/j/1", external: true });
  const bad = pickNextEvent([ev("z", 5, { live_mode: "external", zoom_url: "javascript:alert(1)" })], NOW, {
    preCohort: false,
  });
  assert.equal(bad?.join, null);
});

test("next event: pre-cohort sees hosted rooms only, linked to the room", () => {
  const rows = [ev("ext", 30, { live_mode: "external", zoom_url: "https://x.test/j" }), ev("room", 90)];
  const got = pickNextEvent(rows, NOW, { preCohort: true });
  assert.equal(got?.id, "room");
  assert.equal(got?.href, "/dashboard/events/room/live");
  assert.equal(pickNextEvent([rows[0]], NOW, { preCohort: true }), null);
});

function call(id: string, startMin: number, status: "invited" | "accepted" | "cancelled" = "invited") {
  return { id, startsAt: at(startMin), durationMinutes: 30, status };
}

test("next call: an open room first, then the soonest ahead", () => {
  const got = pickNextCall([call("tomorrow", 24 * 60), call("open", 5), call("gone", 60, "cancelled")], NOW);
  assert.equal(got?.invite.id, "open");
  assert.equal(got?.joinable, true);
  const later = pickNextCall([call("b", 300), call("a", 120)], NOW);
  assert.equal(later?.invite.id, "a");
  assert.equal(later?.joinable, false);
});

test("next call: nothing when every call is over", () => {
  assert.equal(pickNextCall([call("old", -24 * 60)], NOW), null);
});

const item = (id: string, status: any, dueMin: number | null) => ({
  id,
  status,
  assignment: { due_at: dueMin === null ? null : at(dueMin) },
});

test("due soon: owed work within a week, ranked, at most the limit", () => {
  const items = [
    item("late", "missing", -60),
    item("week", "open", 3 * 24 * 60),
    item("far", "open", 20 * 24 * 60),
    item("done", "submitted", 60),
    item("back", "returned", 9 * 24 * 60),
    item("today", "due_today", 120),
  ];
  const got = dueSoon(items, NOW);
  assert.deepEqual(
    got.items.map((i) => i.id),
    ["back", "today", "week"],
  );
  assert.equal(got.more, 1);
  assert.deepEqual(dueSoon(items, NOW, 1).items.map((i) => i.id), ["back"]);
  assert.equal(dueSoon(items, NOW, 10).more, 0);
});

test("due soon: stale late work doesn't hide what is due tomorrow", () => {
  const items = [
    item("wk1", "missing", -5 * 7 * 24 * 60),
    item("wk2", "missing", -4 * 7 * 24 * 60),
    item("wk3", "missing", -3 * 7 * 24 * 60),
    item("wk4", "missing", -2 * 7 * 24 * 60),
    item("tomorrow", "open", 24 * 60),
  ];
  const got = dueSoon(items, NOW);
  assert.deepEqual(
    got.items.map((i) => i.id),
    ["tomorrow", "wk4", "wk3"],
  );
  assert.equal(got.more, 2);
});

// ---------------------------------------------------------------------------
// homeNeeds: the one model both homes lay out (/dashboard and /app/home).
// The installed app used to take the first three owed items off the
// oldest-first assignments list and had no 1:1 at all.
// ---------------------------------------------------------------------------

const DAY = 24 * 60;
const ENROLLED = { enrolled: true, preCohort: false };

/** The installed app's old pick, kept to show what it got wrong. */
function oldAppPick<T extends { status: any; assignment: { due_at: string | null } }>(items: T[]) {
  return items.filter((i) => ["missing", "returned", "due_today"].includes(i.status)).slice(0, 3);
}

test("home: today's work beats twenty weeks-old missing items, with an N more row", () => {
  // Oldest first, as loadStudentAssignments returns them (due_at ascending).
  const old = Array.from({ length: 20 }, (_, n) => item(`old${n}`, "missing", -(40 - n) * DAY));
  const items = [...old, item("today", "due_today", 120)];
  assert.ok(!oldAppPick(items).some((i) => i.id === "today"), "the old phone pick hid today's work");

  const got = homeNeeds({ access: ENROLLED, assignments: items, events: [], calls: [], now: NOW });
  assert.deepEqual(
    got.due.items.map((i) => i.id),
    // Today first, then the late work newest first.
    ["today", "old19", "old18"],
  );
  assert.equal(got.due.more, 18);
  assert.equal(moreDueLabel(got.due.more), "18 more assignments due");
  assert.equal(moreDueLabel(1), "1 more assignment due");
});

test("home: the phone and the desktop get the same due list", () => {
  const items = [
    item("late", "missing", -3 * DAY),
    item("tomorrow", "open", DAY),
    item("back", "returned", -DAY),
    item("today", "due_today", 60),
  ];
  const desktop = homeNeeds({ access: ENROLLED, assignments: items, events: [], calls: [], now: NOW });
  const phone = homeNeeds({
    access: ENROLLED,
    assignments: items,
    events: [],
    calls: [],
    now: NOW,
    eventLimit: 2,
    eventsHref: "/app/events",
  });
  assert.deepEqual(phone.due, desktop.due);
  assert.deepEqual(desktop.due.items.map((i) => i.id), ["back", "today", "tomorrow"]);
  assert.equal(desktop.due.more, 1);
});

test("home: a live session is open with Join, ahead of what starts later", () => {
  const got = homeNeeds({
    access: ENROLLED,
    assignments: [],
    events: [ev("later", 3 * 60), ev("live", -20)],
    calls: [call("tomorrow", DAY)],
    now: NOW,
    eventLimit: 2,
    eventsHref: "/app/events",
  });
  assert.deepEqual(
    got.open.map((i) => i.key),
    ["event-live"],
  );
  const live = got.open[0];
  assert.equal(live.kind, "event");
  if (live.kind === "event") {
    assert.equal(live.event.live, true);
    assert.deepEqual(live.event.join, { href: "/dashboard/events/live/live", external: false });
  }
  // Not open yet, soonest first: the event in three hours, then tomorrow's 1:1.
  assert.deepEqual(
    got.later.map((i) => i.key),
    ["event-later", "call-tomorrow"],
  );
  const later = got.later[0];
  if (later.kind === "event") assert.equal(later.event.href, "/app/events");
});

test("home: a joinable 1:1 leads the open rooms; the desktop shows one event, the phone two", () => {
  const events = [ev("a", 5), ev("b", 10), ev("c", 120)];
  const desktop = homeNeeds({ access: ENROLLED, assignments: [], events, calls: [call("now", 5)], now: NOW });
  assert.deepEqual(desktop.open.map((i) => i.key), ["call-now", "event-a"]);
  assert.deepEqual(desktop.later, []);
  const phone = homeNeeds({
    access: ENROLLED,
    assignments: [],
    events,
    calls: [call("now", 5)],
    now: NOW,
    eventLimit: 2,
  });
  assert.deepEqual(phone.open.map((i) => i.key), ["call-now", "event-a", "event-b"]);
});

test("home: a cancelled 1:1 never shows, even one whose room would be open", () => {
  const onlyCancelled = homeNeeds({
    access: ENROLLED,
    assignments: [],
    events: [],
    calls: [call("gone", 5, "cancelled")],
    now: NOW,
  });
  assert.deepEqual(onlyCancelled.open, []);
  assert.deepEqual(onlyCancelled.later, []);

  const withBooked = homeNeeds({
    access: ENROLLED,
    assignments: [],
    events: [],
    calls: [call("gone", 5, "cancelled"), call("booked", 2 * DAY, "accepted")],
    now: NOW,
  });
  assert.deepEqual(withBooked.open, []);
  assert.deepEqual(withBooked.later.map((i) => i.key), ["call-booked"]);
  const booked = withBooked.later[0];
  if (booked.kind === "call") assert.equal(booked.call.joinable, false);
});

test("home: pre-cohort lists no assignments and only hosted rooms, but still the 1:1", () => {
  const got = homeNeeds({
    access: { enrolled: true, preCohort: true },
    // Rows a caller might still have passed: they must not surface before kickoff.
    assignments: [item("early", "due_today", 60)],
    events: [ev("zoom", 30, { live_mode: "external", zoom_url: "https://zoom.us/j/1" }), ev("orientation", 90)],
    calls: [call("intro", DAY)],
    now: NOW,
    eventLimit: 2,
    eventsHref: "/app/events",
  });
  assert.deepEqual(got.due, { items: [], more: 0 });
  assert.deepEqual(got.later.map((i) => i.key), ["event-orientation", "call-intro"]);
  const room = got.later[0];
  // The events list is locked before kickoff; the row goes to the room itself.
  if (room.kind === "event") assert.equal(room.event.href, "/dashboard/events/orientation/live");
});

test("home: an applicant (not enrolled) sees their 1:1 and no assignments", () => {
  const got = homeNeeds({
    access: { enrolled: false, preCohort: false },
    assignments: [item("x", "due_today", 60)],
    events: [],
    calls: [call("interview", 5)],
    now: NOW,
  });
  assert.deepEqual(got.due.items, []);
  assert.deepEqual(got.open.map((i) => i.key), ["call-interview"]);
});

test("pickNextEvents: the limit, the order, and the events link", () => {
  const rows = [ev("c", 300), ev("a", 30), ev("b", 60), ev("live", -5)];
  assert.deepEqual(
    pickNextEvents(rows, NOW, { preCohort: false }, 3).map((e) => e.id),
    ["live", "a", "b"],
  );
  assert.deepEqual(pickNextEvents(rows, NOW, { preCohort: false }, 0), []);
  const far = pickNextEvents([ev("far", 300)], NOW, { preCohort: false, eventsHref: "/app/events" }, 1)[0];
  assert.equal(far.href, "/app/events");
  assert.equal(far.row.id, "far");
  // pickNextEvent is the first of them, linking the desktop list by default.
  assert.equal(pickNextEvent(rows, NOW, { preCohort: false })?.id, "live");
  assert.equal(pickNextEvent([ev("far", 300)], NOW, { preCohort: false })?.href, "/dashboard/events");
});
