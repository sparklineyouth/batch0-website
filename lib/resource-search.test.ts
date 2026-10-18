import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRE_COHORT_RESOURCES_HREF,
  PRE_COHORT_SHELF,
  RESOURCE_QUERY_MAX,
  beforeDayOneLayout,
  matchesResourceQuery,
  onShelf,
  parseResourceQuery,
  parseResourceShelf,
  resourceShelves,
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

test("query round trip: what the box writes is what the page reads back", () => {
  // The box compares its own query with the page's. It used to keep a bare
  // trim ("pitch  deck") while the page collapsed spaces ("pitch deck"), so
  // the two never agreed and the box overwrote whatever was typed meanwhile.
  for (const typed of ["pitch  deck", "  pitch deck ", "a\tb", "x".repeat(RESOURCE_QUERY_MAX), "Résumé  guide"]) {
    const boxQuery = parseResourceQuery(typed);
    const url = new URL(resourcesHref({ q: boxQuery }), "https://batch0.test");
    const pageQuery = parseResourceQuery(url.searchParams.get("q") ?? undefined);
    assert.equal(pageQuery, boxQuery, JSON.stringify(typed));
    assert.equal(parseResourceQuery(boxQuery), boxQuery, "idempotent");
  }
  const box = readFileSync(new URL("../app/dashboard/resources/resource-search.tsx", import.meta.url), "utf8");
  assert.ok(!/value\.trim\(\)/.test(box), "the search box normalises with parseResourceQuery, not trim()");
});

test("shelves: a category named like the pre-cohort shelf shares it, never duplicates it", () => {
  const shelves = resourceShelves({ preCohort: true, categories: ["week 1 · validate", PRE_COHORT_SHELF, "templates"] });
  assert.deepEqual(shelves, [
    { value: PRE_COHORT_SHELF, label: "Pre-cohort" },
    { value: "week 1 · validate", label: "week 1 · validate" },
    { value: "templates", label: "templates" },
  ]);
  assert.equal(new Set(shelves.map((x) => x.value)).size, shelves.length, "unique values (React keys)");
  // Picking it shows that category's rows as well as the pre-cohort block.
  assert.equal(onShelf(PRE_COHORT_SHELF, PRE_COHORT_SHELF), true);
  assert.equal(onShelf("templates", PRE_COHORT_SHELF), false);
  assert.equal(onShelf("templates", "templates"), true);
  assert.equal(onShelf("templates", null), true);
  // No pre-cohort material: that category is just a category.
  assert.deepEqual(resourceShelves({ preCohort: false, categories: [PRE_COHORT_SHELF] }), [
    { value: PRE_COHORT_SHELF, label: PRE_COHORT_SHELF },
  ]);
  assert.deepEqual(resourceShelves({ preCohort: false, categories: [] }), []);
});

test("before day one after kickoff: folds only once every worksheet is done", () => {
  // Unfinished worksheets lead the page, open: kickoff's "Work through Before
  // One" and a late enrollee's "Before One" link send students to exactly that.
  assert.deepEqual(beforeDayOneLayout({ flowsTotal: 4, flowsDone: 1, filtering: false }), { leads: true, open: true });
  assert.deepEqual(beforeDayOneLayout({ flowsTotal: 4, flowsDone: 4, filtering: false }), { leads: false, open: false });
  assert.deepEqual(beforeDayOneLayout({ flowsTotal: 0, flowsDone: 0, filtering: false }), { leads: false, open: false });
  // A search or the pre-cohort shelf opens it wherever it sits.
  assert.deepEqual(beforeDayOneLayout({ flowsTotal: 4, flowsDone: 4, filtering: true }), { leads: false, open: true });
  assert.equal(PRE_COHORT_RESOURCES_HREF, "/dashboard/resources?shelf=pre-cohort");
  assert.equal(parseResourceShelf(new URL(PRE_COHORT_RESOURCES_HREF, "https://batch0.test").searchParams.get("shelf") ?? undefined, [PRE_COHORT_SHELF]), PRE_COHORT_SHELF);
});

test("page: Build receipts is its own row, outside the pre-cohort block and every filter", () => {
  const page = readFileSync(new URL("../app/dashboard/resources/page.tsx", import.meta.url), "utf8");
  // The one link to the feed used to be the last line of Before One, so
  // folding that block, or a search that matched no worksheet, took it away.
  const material = page.slice(page.indexOf("function PreCohortMaterial("), page.indexOf("function BuildReceiptsLink("));
  assert.ok(material.length > 0, "PreCohortMaterial precedes BuildReceiptsLink");
  assert.ok(!material.includes("/dashboard/resources/receipts"), "receipts link inside PreCohortMaterial");
  const uses = page.split("\n").filter((l) => l.includes("<BuildReceiptsLink"));
  assert.equal(uses.length, 1);
  assert.ok(/^\s*<BuildReceiptsLink \/>\s*$/.test(uses[0]), "rendered unconditionally, not behind a filter");
  // The links that promise pre-cohort material open it after kickoff.
  for (const f of ["../app/dashboard/kickoff/page.tsx", "../app/dashboard/enrolled/page.tsx"]) {
    assert.ok(readFileSync(new URL(f, import.meta.url), "utf8").includes("PRE_COHORT_RESOURCES_HREF"), f);
  }
});
