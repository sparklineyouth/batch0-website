import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FOR_UNKNOWN,
  IMPORTANCE_GROUPS,
  NOTIFICATION_KINDS,
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
  for (const k of NOTIFICATION_KINDS) {
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
