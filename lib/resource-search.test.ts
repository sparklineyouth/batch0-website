import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRE_COHORT_SHELF,
  RESOURCE_QUERY_MAX,
  matchesResourceQuery,
  parseResourceQuery,
  parseResourceShelf,
  resourcesHref,
} from "./resource-search.ts";

// Run with `npm test`. /dashboard/resources had category headings and no way
// to search them.

test("query: trimmed, whitespace collapsed, capped", () => {
  assert.equal(parseResourceQuery(undefined), "");
  assert.equal(parseResourceQuery("   "), "");
  assert.equal(parseResourceQuery("  pitch   deck \n"), "pitch deck");
  assert.equal(parseResourceQuery(["deck", "other"]), "deck");
  assert.equal(parseResourceQuery("x".repeat(500)).length, RESOURCE_QUERY_MAX);
});

test("match: every word, any field, any order, case and accents folded", () => {
  const deck = ["Pitch deck template", "Ten slides for Demo Day", "templates"];
  assert.equal(matchesResourceQuery(deck, ""), true);
  assert.equal(matchesResourceQuery(deck, "deck pitch"), true);
  assert.equal(matchesResourceQuery(deck, "DEMO"), true);
  assert.equal(matchesResourceQuery(deck, "templates slides"), true, "category and description");
  assert.equal(matchesResourceQuery(deck, "deck budget"), false, "all words must match");
  assert.equal(matchesResourceQuery(["Résumé guide", null, undefined], "resume"), true);
  assert.equal(matchesResourceQuery(["Resume guide"], "résumé"), true);
  assert.equal(matchesResourceQuery([null, undefined], "x"), false);
});

test("shelf: only one the page has; anything else is no filter", () => {
  const shelves = [PRE_COHORT_SHELF, "week 1 · validate", "templates"];
  assert.equal(parseResourceShelf("templates", shelves), "templates");
  assert.equal(parseResourceShelf(PRE_COHORT_SHELF, shelves), PRE_COHORT_SHELF);
  assert.equal(parseResourceShelf("week 1 · validate", shelves), "week 1 · validate");
  assert.equal(parseResourceShelf("decks", shelves), null);
  assert.equal(parseResourceShelf("", shelves), null);
  assert.equal(parseResourceShelf(undefined, shelves), null);
  // A pre-cohort student's page has no shelves to pick from.
  assert.equal(parseResourceShelf("templates", []), null);
});

test("href: empty parts stay out of the URL", () => {
  assert.equal(resourcesHref({}), "/dashboard/resources");
  assert.equal(resourcesHref({ q: "  " }), "/dashboard/resources");
  assert.equal(resourcesHref({ q: "deck" }), "/dashboard/resources?q=deck");
  assert.equal(
    resourcesHref({ q: "pitch deck", shelf: "week 1 · validate" }),
    "/dashboard/resources?q=pitch+deck&shelf=week+1+%C2%B7+validate",
  );
  assert.equal(resourcesHref({ shelf: null }), "/dashboard/resources");
});
