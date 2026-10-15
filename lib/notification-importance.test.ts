import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FOR_UNKNOWN,
  IMPORTANCE_GROUPS,
  NOTIFICATION_KINDS,
  RETIRED_NOTIFICATION_KINDS,
  defaultImportance,
  importanceOf,
  isImportanceValue,
  isImportant,
  kindFor,
  labelForType,
  splitByImportance,
  type ImportanceOverrides,
} from "./notification-importance.ts";

// Run with `npm test`. No framework, no transpile step — Node strips the types
// natively, which is why notification-importance.ts is kept import-free.

test("the catalog has no duplicate types", () => {
  const seen = new Set<string>();
  for (const k of [...NOTIFICATION_KINDS, ...RETIRED_NOTIFICATION_KINDS]) {
    assert.equal(seen.has(k.type), false, `duplicate entry for ${k.type}`);
    seen.add(k.type);
  }
});

test("every catalog entry lands in a declared group", () => {
  const groups = new Set<string>(IMPORTANCE_GROUPS);
  for (const k of NOTIFICATION_KINDS) {
    assert.equal(
      groups.has(k.group),
      true,
      `${k.type} is in unknown group "${k.group}"`,
    );
  }
});

test("defaults apply when the person hasn't chosen", () => {
  assert.equal(defaultImportance("payment_failed"), "important");
  assert.equal(defaultImportance("charge_paid"), "other");
  assert.equal(importanceOf("charge_paid", {}), "other");
  assert.equal(isImportant("payment_failed", {}), true);
});

test("an unknown type is important, and still gets a readable label", () => {
  assert.equal(kindFor("brand_new_thing"), undefined);
  assert.equal(defaultImportance("brand_new_thing"), DEFAULT_FOR_UNKNOWN);
  assert.equal(importanceOf("brand_new_thing", {}), "important");
  assert.equal(labelForType("brand_new_thing"), "Brand new thing");
  // A known type keeps its written label rather than the humanised type.
  assert.equal(labelForType("payment_failed"), "Payment failed");
});

test("an override wins over the default, in both directions", () => {
  const overrides: ImportanceOverrides = {
    payment_failed: "other",
    charge_paid: "important",
  };
  assert.equal(importanceOf("payment_failed", overrides), "other");
  assert.equal(importanceOf("charge_paid", overrides), "important");
  // Untouched types are unaffected.
  assert.equal(importanceOf("team_invite", overrides), "important");
});

test("splitByImportance keeps each side in the original order", () => {
  const rows = [
    { id: "1", type: "payment_failed" },
    { id: "2", type: "charge_paid" },
    { id: "3", type: "team_invite" },
    { id: "4", type: "event_posted" },
  ];
  const { important, other } = splitByImportance(rows, {});
  assert.deepEqual(
    important.map((r) => r.id),
    ["1", "3"],
  );
  assert.deepEqual(
    other.map((r) => r.id),
    ["2", "4"],
  );

  // Reclassifying one type moves exactly that row across.
  const moved = splitByImportance(rows, { team_invite: "other" });
  assert.deepEqual(
    moved.important.map((r) => r.id),
    ["1"],
  );
  assert.deepEqual(
    moved.other.map((r) => r.id),
    ["2", "3", "4"],
  );
});

test("every row lands in exactly one tab", () => {
  const rows = NOTIFICATION_KINDS.map((k) => ({ type: k.type })).concat([
    { type: "something_unlisted" },
  ]);
  const { important, other } = splitByImportance(rows, {
    announcement: "other",
    charge_paid: "important",
  });
  assert.equal(important.length + other.length, rows.length);
});

test("isImportanceValue guards the server action's input", () => {
  assert.equal(isImportanceValue("important"), true);
  assert.equal(isImportanceValue("other"), true);
  assert.equal(isImportanceValue("Important"), false);
  assert.equal(isImportanceValue(""), false);
  assert.equal(isImportanceValue(null), false);
  assert.equal(isImportanceValue(undefined), false);
});

test("retired types are quiet, labelled, and not offered in settings", () => {
  const offered = new Set(NOTIFICATION_KINDS.map((k) => k.type));
  for (const type of [
    "team_message",
    "direct_message",
    "discussion_question",
    "discussion_reply",
    "dm_reported",
    "checkin_nudge",
    "intervention",
    "checkin_feedback",
    "checkin_submitted",
    "office_hours_booked",
    "office_hours_recap",
    "file_feedback",
    "certificate_issued",
  ]) {
    assert.equal(defaultImportance(type), "other", type);
    assert.notEqual(kindFor(type), undefined, `${type} must not fall to DEFAULT_FOR_UNKNOWN`);
    assert.notEqual(labelForType(type), type, `${type} keeps a written label`);
    assert.equal(offered.has(type), false, `${type} must not be a settings row`);
  }
  // A person's explicit choice still wins for the rows they already have.
  assert.equal(importanceOf("direct_message", { direct_message: "important" }), "important");
});

test("every chat bell is a settings row: DMs, mentions, reports and help flags are important", () => {
  // The types lib/chat-notify.ts and app/chat/actions.ts send. Unlisted, one
  // would still be important (DEFAULT_FOR_UNKNOWN) but nobody could quiet it
  // from the settings tab, and it would show as a humanised type name.
  const expected: Record<string, "important" | "other"> = {
    chat_dm: "important",
    chat_mention: "important",
    chat_message: "other",
    chat_reported: "important",
    chat_flagged: "important",
  };
  const offered = new Map(NOTIFICATION_KINDS.map((k) => [k.type, k]));
  for (const [type, importance] of Object.entries(expected)) {
    assert.ok(offered.has(type), `${type} must be a settings row`);
    assert.equal(defaultImportance(type), importance, type);
  }
  // Both go to chat staff only, so they sit with the other staff queues.
  assert.equal(offered.get("chat_reported")?.group, "Staff queues");
  assert.equal(offered.get("chat_flagged")?.group, "Staff queues");
});
