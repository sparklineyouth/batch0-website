import { test } from "node:test";
import assert from "node:assert/strict";
import { bouncesFromDashboard, isLiveRoomPath, isSupportPath } from "./dashboard-gate.ts";

// Run with `npm test`. The rule the middleware applies to /dashboard for a
// viewer without `student.dashboard` — a mentor or an investor.

const mentor = { studentDashboard: false, home: "/mentor" };
const investor = { studentDashboard: false, home: "/investor" };
const ROOM = "/dashboard/calls/5b1e2f0a-8c7d-4e6f-9a0b-1c2d3e4f5a6b/live";
const WEBINAR = "/dashboard/events/5b1e2f0a-8c7d-4e6f-9a0b-1c2d3e4f5a6b/live";
const intern = { studentDashboard: false, home: "/admin" };

test("a mentor or investor host can open their own 1:1 room", () => {
  assert.equal(bouncesFromDashboard({ path: ROOM, ...mentor }), false);
  assert.equal(bouncesFromDashboard({ path: `${ROOM}/`, ...investor }), false);
});

test("a webinar host or attendee without the student view can open the webinar room", () => {
  // An intern with Manage events, a mentor guest speaker, an investor watching.
  assert.equal(bouncesFromDashboard({ path: WEBINAR, ...intern }), false);
  assert.equal(bouncesFromDashboard({ path: WEBINAR, ...mentor }), false);
  assert.equal(bouncesFromDashboard({ path: `${WEBINAR}/`, ...investor }), false);
});

test("the rest of the student area still bounces them home", () => {
  for (const path of [
    "/dashboard",
    "/dashboard/calls",
    "/dashboard/calls/abc",
    `${ROOM}/extra`,
    "/dashboard/events",
    "/dashboard/events/abc",
    `${WEBINAR}/extra`,
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

test("every role can reach Help & support: the list, the form and a thread", () => {
  // A custom staff role with no student view, e.g. an intern whose home is /admin.
  const customStaff = { studentDashboard: false, home: "/admin" };
  for (const viewer of [mentor, investor, customStaff]) {
    for (const path of [
      "/dashboard/support",
      "/dashboard/support/",
      "/dashboard/support/new",
      "/dashboard/support/B0-4F2A-9C7K",
    ]) {
      assert.equal(bouncesFromDashboard({ path, ...viewer }), false, `${viewer.home} ${path}`);
    }
  }
});

test("only the support segment is exempt, not look-alikes", () => {
  assert.equal(isSupportPath("/dashboard/support"), true);
  assert.equal(isSupportPath("/dashboard/support/new"), true);
  assert.equal(isSupportPath("/dashboard/supporters"), false);
  assert.equal(isSupportPath("/dashboard/supportx/new"), false);
  assert.equal(isSupportPath("/support"), false);
  assert.equal(isSupportPath("/admin/support"), false);
  assert.equal(bouncesFromDashboard({ path: "/dashboard/supporters", ...mentor }), true);
});

test("a role whose home IS /dashboard is never bounced at itself", () => {
  assert.equal(
    bouncesFromDashboard({ path: "/dashboard/course", studentDashboard: false, home: "/dashboard" }),
    false,
  );
});

test("only the two rooms match, not look-alikes", () => {
  assert.equal(isLiveRoomPath(ROOM), true);
  assert.equal(isLiveRoomPath(WEBINAR), true);
  assert.equal(isLiveRoomPath(`${WEBINAR}/`), true);
  assert.equal(isLiveRoomPath("/dashboard/calls//live"), false);
  assert.equal(isLiveRoomPath("/dashboard/calls/x/live/y"), false);
  assert.equal(isLiveRoomPath("/dashboard/events//live"), false);
  assert.equal(isLiveRoomPath("/dashboard/events/x"), false);
  assert.equal(isLiveRoomPath("/dashboard/teams/x/live"), false);
  assert.equal(isLiveRoomPath("/mentor/calls/x/live"), false);
  assert.equal(isLiveRoomPath("/admin/events/x/live"), false);
});
