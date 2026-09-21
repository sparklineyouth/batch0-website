import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESOURCE_CATEGORIES,
  SPRINT_CATEGORIES,
  sortCategories,
} from "./resource-categories.ts";

// Run with `npm test`. The resources page used to sort headings with a bare
// .sort(), which put "week 1 · validate" after "tools" — the one shelf a
// student in Week 1 is looking for, at the bottom of the page.

test("sprint categories lead, in week order, ahead of the generic shelves", () => {
  const shown = sortCategories([
    "tools",
    "week 2 · build",
    "readings",
    "week 1 · validate",
    "general",
  ]);
  assert.deepEqual(shown, [
    "week 1 · validate",
    "week 2 · build",
    "general",
    "readings",
    "tools",
  ]);
});

test("week order is numeric, not lexical", () => {
  // A lexical sort puts "week 10" before "week 2".
  assert.deepEqual(sortCategories(["week 10 · demo", "week 2 · build"]), [
    "week 2 · build",
    "week 10 · demo",
  ]);
});

test("unrecognised admin-typed categories sort with the generic shelves", () => {
  assert.deepEqual(sortCategories(["zines", "week 1 · validate", "Decks"]), [
    "week 1 · validate",
    "Decks",
    "zines",
  ]);
});

test("duplicates collapse and the input order does not matter", () => {
  assert.deepEqual(sortCategories(["tools", "tools", "guides"]), ["guides", "tools"]);
  assert.deepEqual(sortCategories([]), []);
});

test("the admin form offers every sprint category exactly once, first", () => {
  assert.deepEqual(RESOURCE_CATEGORIES.slice(0, SPRINT_CATEGORIES.length), [
    ...SPRINT_CATEGORIES,
  ]);
  assert.equal(new Set(RESOURCE_CATEGORIES).size, RESOURCE_CATEGORIES.length);
  // The migration files Week 1 readings under exactly this string.
  assert.ok(RESOURCE_CATEGORIES.includes("week 1 · validate"));
});
