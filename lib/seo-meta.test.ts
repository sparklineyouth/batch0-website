import { test } from "node:test";
import assert from "node:assert/strict";
import {
  META_DESCRIPTION_MAX,
  TITLE_TAG_MAX,
  blogTitleTag,
  buildMetaDescription,
  formatApplyBy,
  formatDateSentence,
  pickRelated,
  relatednessScore,
  titleTerms,
} from "./seo-meta.ts";

// Run with `npm test`. No test framework, no transpile step — Node strips the
// types natively, which is why lib/seo-meta.ts is kept import-free.

// The real Cohort 1 record as of 2026-08-05. Kept here as a regression anchor:
// this is the exact data that produced the wrong production snippet.
const COHORT_1 = {
  cohortLabel: "Cohort 1",
  startsOn: "2026-09-14",
  endsOn: "2026-11-13",
  applicationsCloseAt: "2026-09-10T23:59:00+00:00",
  basePriceLabel: "$130",
};

// ---------- formatDateSentence ----------

test("formatDateSentence renders an en-dashed range with a single year", () => {
  assert.equal(
    formatDateSentence("2026-09-14", "2026-11-13"),
    "Sep 14 – Nov 13, 2026",
  );
});

test("formatDateSentence carries the year on both ends across a boundary", () => {
  assert.equal(
    formatDateSentence("2026-12-01", "2027-02-05"),
    "Dec 1, 2026 – Feb 5, 2027",
  );
});

test("formatDateSentence never emits the on-page arrow glyph", () => {
  // A "→" in a SERP snippet reads as a mojibake bug to a searcher.
  assert.ok(!formatDateSentence("2026-09-14", "2026-11-13").includes("→"));
});

test("formatDateSentence does not shift dates west of UTC", () => {
  // Regression guard: parsing "2026-09-14" as local time in a US timezone
  // yields Sep 13. The cohort start date must survive the server's TZ.
  const original = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    assert.ok(formatDateSentence("2026-09-14", "2026-11-13").startsWith("Sep 14"));
  } finally {
    process.env.TZ = original;
  }
});

test("formatDateSentence and formatApplyBy degrade to empty, never to junk", () => {
  assert.equal(formatDateSentence(null, "2026-11-13"), "");
  assert.equal(formatDateSentence("2026-09-14", null), "");
  assert.equal(formatDateSentence("not-a-date", "2026-11-13"), "");
  assert.equal(formatApplyBy(null), "");
  assert.equal(formatApplyBy("not-a-date"), "");
});

// ---------- buildMetaDescription ----------

test("live cohort snippet names the dates and the deadline", () => {
  const out = buildMetaDescription({
    ...COHORT_1,
    now: new Date("2026-08-05T12:00:00Z"),
  });
  assert.match(out, /Cohort 1: Sep 14 – Nov 13/);
  assert.match(out, /apply by Sep 10/);
  assert.match(out, /no equity taken/);
});

test("when the budget binds, the deadline outranks the year", () => {
  // At real Cohort 1 values the fully-specified string is 158 chars. The
  // ladder must sacrifice "2026" rather than "apply by Sep 10" — the deadline
  // is what makes a student act today; the year is inferable.
  const out = buildMetaDescription({
    ...COHORT_1,
    now: new Date("2026-08-05T12:00:00Z"),
  });
  assert.match(out, /apply by Sep 10/);
  assert.ok(!out.includes("Nov 13, 2026"), `year should have been dropped: ${out}`);
});

test("the year comes back once the deadline clause is gone", () => {
  // Budget freed up — spend it on precision rather than leaving it unused.
  const out = buildMetaDescription({
    ...COHORT_1,
    now: new Date("2026-09-11T12:00:00Z"),
  });
  assert.match(out, /Sep 14 – Nov 13, 2026/);
  assert.ok(out.length <= META_DESCRIPTION_MAX);
});

test("snippet fits Google's truncation budget", () => {
  const out = buildMetaDescription({
    ...COHORT_1,
    now: new Date("2026-08-05T12:00:00Z"),
  });
  assert.ok(
    out.length <= META_DESCRIPTION_MAX,
    `description is ${out.length} chars, budget is ${META_DESCRIPTION_MAX}: ${out}`,
  );
});

test("the closing objection-handler survives truncation", () => {
  // The tail is the whole point: "free to apply, no equity taken" is what
  // converts a skeptical parent. If the budget ever forces a cut, it must
  // take the dates, not this.
  const out = buildMetaDescription({
    ...COHORT_1,
    now: new Date("2026-08-05T12:00:00Z"),
  });
  assert.ok(out.trimEnd().endsWith("free to apply, no equity taken."));
});

test("a passed deadline is dropped, not advertised", () => {
  // THE regression this whole module exists for. On 2026-09-11 the snippet
  // must not still be telling students to "apply by Sep 10".
  const out = buildMetaDescription({
    ...COHORT_1,
    now: new Date("2026-09-11T12:00:00Z"),
  });
  assert.ok(!out.includes("apply by"), `still advertising a dead deadline: ${out}`);
  // Dates stay — the cohort itself is still real and still worth describing.
  assert.match(out, /Sep 14 – Nov 13, 2026/);
});

test("the deadline is live right up to the closing instant", () => {
  const justBefore = buildMetaDescription({
    ...COHORT_1,
    now: new Date("2026-09-10T23:58:00Z"),
  });
  const exactly = buildMetaDescription({
    ...COHORT_1,
    now: new Date("2026-09-10T23:59:00Z"),
  });
  assert.match(justBefore, /apply by Sep 10/);
  assert.ok(!exactly.includes("apply by"));
});

test("a missing close date fails closed", () => {
  // No deadline data must never render as "applications open forever".
  const out = buildMetaDescription({
    ...COHORT_1,
    applicationsCloseAt: null,
    now: new Date("2026-08-05T12:00:00Z"),
  });
  assert.ok(!out.includes("apply by"));
});

test("no cohort data still yields a valid, truthful snippet", () => {
  const out = buildMetaDescription({
    cohortLabel: "",
    startsOn: null,
    endsOn: null,
    applicationsCloseAt: null,
    basePriceLabel: "$130",
  });
  assert.ok(out.length <= META_DESCRIPTION_MAX);
  assert.match(out, /startup accelerator for high schoolers/);
  // Must not invent a cohort clause out of empty strings.
  assert.ok(!out.includes("::"));
  assert.ok(!out.includes(": ."));
  assert.ok(!/:\s*\./.test(out));
});

test("an unnumbered cohort still reads as English", () => {
  const out = buildMetaDescription({
    ...COHORT_1,
    cohortLabel: "",
    now: new Date("2026-08-05T12:00:00Z"),
  });
  assert.match(out, /Next cohort: Sep 14 – Nov 13/);
});

test("a cross-year cohort always keeps both years", () => {
  // Ambiguity here would be worse than truncation: "Dec 1 – Feb 5" without
  // years could mean a cohort that already happened.
  const out = buildMetaDescription({
    ...COHORT_1,
    startsOn: "2026-12-01",
    endsOn: "2027-02-05",
    applicationsCloseAt: "2026-11-20T23:59:00+00:00",
    now: new Date("2026-08-05T12:00:00Z"),
  });
  assert.match(out, /Dec 1, 2026 – Feb 5, 2027/);
});

test("formatDateSentence honours year:false only within one year", () => {
  assert.equal(
    formatDateSentence("2026-09-14", "2026-11-13", { year: false }),
    "Sep 14 – Nov 13",
  );
  assert.equal(
    formatDateSentence("2026-12-01", "2027-02-05", { year: false }),
    "Dec 1, 2026 – Feb 5, 2027",
  );
});

test("audience wording stays global", () => {
  // The FAQ tells students they can join from anywhere and lib/pricing.ts
  // ships regional tuition. "U.S. high schoolers" in the snippet contradicts
  // both and disqualifies international applicants at first contact.
  const out = buildMetaDescription({
    ...COHORT_1,
    now: new Date("2026-08-05T12:00:00Z"),
  });
  assert.ok(!/U\.?S\.?\s+high schoolers/i.test(out));
});

test("a long price label degrades gracefully instead of overflowing", () => {
  const out = buildMetaDescription({
    ...COHORT_1,
    basePriceLabel: "$1,300,000 (introductory founding-cohort rate)",
    now: new Date("2026-08-05T12:00:00Z"),
  });
  // Can't always fit, but must never throw and must never keep the longest
  // candidate when a shorter one fits.
  assert.ok(typeof out === "string" && out.length > 0);
  assert.ok(!out.includes("apply by"));
});

// ---------- blogTitleTag ----------

test("short titles keep the brand suffix", () => {
  assert.equal(blogTitleTag("What Is an MVP?"), "What Is an MVP? — batch0");
});

test("the brand suffix is dropped rather than truncated", () => {
  // The old behaviour appended unconditionally, pushing 58 of 135 posts past
  // the budget — and the truncation ate the very suffix it was adding.
  const long = "How to Actually Win the Prize Money at a Pitch Competition";
  assert.ok(long.length <= TITLE_TAG_MAX, "fixture should fit unbranded");
  assert.ok((long + " — batch0").length > TITLE_TAG_MAX, "fixture should not fit branded");

  const out = blogTitleTag(long);
  assert.equal(out, long);
  assert.ok(out.length <= TITLE_TAG_MAX);
});

test("an over-budget headline is returned intact, never mangled", () => {
  // When even the bare title is too long the answer is a content fix
  // (`seoTitle`), not a silent truncation that could cut mid-word. The
  // seo-doctor blog audit is what surfaces these.
  const tooLong = "Startup Accelerator Programs for High Schoolers: A 2026 Guide";
  assert.ok(tooLong.length > TITLE_TAG_MAX);
  assert.equal(blogTitleTag(tooLong), tooLong);
});

test("seoTitle overrides the headline for the title tag only", () => {
  const out = blogTitleTag(
    "How to Convince Skeptical Parents to Let You Join a Startup Program",
    "How to Get Parents to Say Yes to a Startup Program",
  );
  assert.equal(out, "How to Get Parents to Say Yes to a Startup Program — batch0");
  assert.ok(out.length <= TITLE_TAG_MAX);
});

test("a blank seoTitle falls back to the title", () => {
  assert.equal(blogTitleTag("What Is an MVP?", "   "), "What Is an MVP? — batch0");
  assert.equal(blogTitleTag("What Is an MVP?", null), "What Is an MVP? — batch0");
});

// ---------- topical relatedness ----------

const post = (
  slug: string,
  title: string,
  category: string,
  tags: string[] = [],
) => ({ slug, title, category, tags });

test("titleTerms strips stopwords and short words", () => {
  const terms = titleTerms("How to Write a Pitch Deck for a Competition");
  assert.ok(terms.has("write"));
  assert.ok(terms.has("pitch"));
  assert.ok(terms.has("deck"));
  assert.ok(terms.has("competition"));
  assert.ok(!terms.has("how"));
  assert.ok(!terms.has("to"));
  assert.ok(!terms.has("for"));
});

test("shared tags outweigh a shared category", () => {
  const current = post("a", "Alpha", "Pitch", ["pitch deck"]);
  const tagMatch = post("b", "Bravo", "Founders", ["pitch deck"]);
  const catOnly = post("c", "Charlie", "Pitch", ["taxes"]);
  assert.ok(
    relatednessScore(current, tagMatch) > relatednessScore(current, catOnly),
  );
});

test("shared title terms rescue posts with no tag overlap", () => {
  // 45 of 135 posts share no tag with any other post. Tags alone would leave
  // a third of the catalogue with no meaningful internal links.
  const current = post("a", "How to Make a Pitch Deck in Canva", "Pitch", ["canva"]);
  const termMatch = post("b", "The Pitch Deck Slide Order That Works", "Founders", ["slides"]);
  const unrelated = post("c", "Do You Pay Taxes on Teen Business Income?", "Founders", ["taxes"]);
  assert.ok(
    relatednessScore(current, termMatch) > relatednessScore(current, unrelated),
  );
});

test("a post is never related to itself", () => {
  const p = post("a", "Alpha", "Pitch", ["x"]);
  assert.equal(relatednessScore(p, p), -1);
  assert.deepEqual(pickRelated(p, [p], 3), []);
});

test("pickRelated surfaces the topical cluster, not the category", () => {
  // The regression this replaces: "same category, then most recent" linked
  // every pitch post to the same three recent siblings, so nine pitch-deck
  // guides never linked to each other.
  const current = post("how-to-make-a-pitch-deck-in-canva", "How to Make a Pitch Deck in Canva", "Pitch", ["pitch deck"]);
  const candidates = [
    current,
    post("pitch-deck-slide-order", "The Pitch Deck Slide Order That Works", "Pitch", ["pitch deck"]),
    post("how-many-slides-in-a-pitch-deck", "How Many Slides Should a Pitch Deck Have?", "Pitch", ["pitch deck"]),
    post("what-to-wear-to-a-pitch-competition", "What to Wear to a Pitch Competition", "Pitch", ["dress code"]),
    post("how-to-not-be-nervous-pitching", "How to Not Be Nervous When You Pitch", "Pitch", ["nerves"]),
  ];
  const related = pickRelated(current, candidates, 3).map((p) => p.slug);
  assert.ok(related.includes("pitch-deck-slide-order"));
  assert.ok(related.includes("how-many-slides-in-a-pitch-deck"));
  assert.ok(!related.includes("what-to-wear-to-a-pitch-competition"));
});

test("pickRelated is deterministic and respects the limit", () => {
  const current = post("a", "Alpha Beta", "Pitch", ["x"]);
  const candidates = [
    post("z", "Alpha Gamma", "Pitch", ["x"]),
    post("y", "Alpha Delta", "Pitch", ["x"]),
    post("x", "Alpha Epsilon", "Pitch", ["x"]),
  ];
  const first = pickRelated(current, candidates, 2).map((p) => p.slug);
  const second = pickRelated(current, [...candidates].reverse(), 2).map((p) => p.slug);
  assert.equal(first.length, 2);
  // Ties break on slug, so input order cannot reshuffle the link graph.
  assert.deepEqual(first, second);
});

test("pickRelated still returns something when nothing overlaps", () => {
  // Every post must get internal links, even a topical orphan.
  const current = post("a", "Zebra Xylophone", "Pitch", ["nothing"]);
  const candidates = [
    post("b", "Quantum Mechanics", "Build", ["other"]),
    post("c", "Baking Bread", "Market", ["else"]),
  ];
  assert.equal(pickRelated(current, candidates, 3).length, 2);
});
