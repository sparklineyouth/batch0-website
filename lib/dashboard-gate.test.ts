import { test } from "node:test";
import assert from "node:assert/strict";
import { bouncesFromDashboard, isCallRoomPath } from "./dashboard-gate.ts";

// Run with `npm test`. The rule the middleware applies to /dashboard for a
// viewer without `student.dashboard` — a mentor or an investor.

const mentor = { studentDashboard: false, home: "/mentor" };
const investor = { studentDashboard: false, home: "/investor" };
const ROOM = "/dashboard/calls/5b1e2f0a-8c7d-4e6f-9a0b-1c2d3e4f5a6b/live";

test("a mentor or investor host can open their own 1:1 room", () => {
  assert.equal(bouncesFromDashboard({ path: ROOM, ...mentor }), false);
  assert.equal(bouncesFromDashboard({ path: `${ROOM}/`, ...investor }), false);
});

test("the rest of the student area still bounces them home", () => {
  for (const path of [
    "/dashboard",
    "/dashboard/calls",
    "/dashboard/calls/abc",
    `${ROOM}/extra`,
    "/dashboard/course",
  ]) {
    assert.equal(bouncesFromDashboard({ path, ...mentor }), true, path);
  }
});

test("billing and pay-fine stay shared, and a student is never bounced", () => {
  assert.equal(bouncesFromDashboard({ path: "/dashboard/billing", ...mentor }), false);
  assert.equal(bouncesFromDashboard({ path: "/dashboard/pay-fine", ...mentor }), false);
  assert.equal(
    bouncesFromDashboard({ path: "/dashboard/course", studentDashboard: true, home: "/dashboard" }),
    false,
  );
});

test("a role whose home IS /dashboard is never bounced at itself", () => {
  assert.equal(
    bouncesFromDashboard({ path: "/dashboard/course", studentDashboard: false, home: "/dashboard" }),
    false,
  );
});

test("only the room matches, not look-alikes", () => {
  assert.equal(isCallRoomPath(ROOM), true);
  assert.equal(isCallRoomPath("/dashboard/calls//live"), false);
  assert.equal(isCallRoomPath("/dashboard/calls/x/live/y"), false);
  assert.equal(isCallRoomPath("/dashboard/events/x/live"), false);
  assert.equal(isCallRoomPath("/mentor/calls/x/live"), false);
});
