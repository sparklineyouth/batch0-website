import { test } from "node:test";
import assert from "node:assert/strict";
import { dueSoon, pickNextCall, pickNextEvent, type HomeEventRow } from "./needs-you.ts";

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
