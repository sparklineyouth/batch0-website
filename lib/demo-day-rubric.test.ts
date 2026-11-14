import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PITCH_RUBRIC,
  anchorForScore,
  anchorsToText,
  applicableCriteria,
  buildScorecard,
  coerceAnchors,
  formatScore,
  parseAnchorLines,
  type CriterionRow,
} from "./demo-day-rubric.ts";

// The scorecard these functions produce is what founders are shown and
// emailed, and what orders the Demo Day leaderboard. The tests pin the
// properties a wrong number would violate: an unjudged team must not look
// like a badly judged one, a criterion scored on a different scale must not
// buy extra influence, and a criterion nobody scored must not drag a team
// down.

const CRITERIA: CriterionRow[] = [
  { id: "a", label: "Problem", weight: 20, max_score: 5 },
  { id: "b", label: "Product", weight: 30, max_score: 5 },
  { id: "c", label: "Traction", weight: 50, max_score: 10 },
];

test("the shipped rubric has five criteria whose weights sum to 100", () => {
  assert.equal(DEFAULT_PITCH_RUBRIC.length, 5);
  const total = DEFAULT_PITCH_RUBRIC.reduce((s, c) => s + c.weight, 0);
  assert.equal(total, 100);
});

test("every default criterion has an anchor for each score it allows", () => {
  for (const c of DEFAULT_PITCH_RUBRIC) {
    assert.ok(c.anchors.length >= c.max_score, `${c.label} is missing anchors`);
    const levels = c.anchors.map((a) => a.level);
    assert.deepEqual(
      [...levels].sort((x, y) => y - x),
      levels,
      `${c.label} anchors must read top-down`,
    );
    for (const a of c.anchors) {
      assert.ok(a.level >= 0 && a.level <= c.max_score);
      assert.ok(a.label.trim().length > 20, `${c.label} anchor is too thin`);
    }
  }
});

test("an unjudged team scores null, not zero", () => {
  const card = buildScorecard(CRITERIA, []);
  assert.equal(card.weightedPct, null);
  assert.equal(card.judgeCount, 0);
  assert.equal(card.scoredCount, 0);
  assert.deepEqual(
    card.rows.map((r) => r.average),
    [null, null, null],
  );
});

test("a criterion is averaged across judges before it is weighted", () => {
  const card = buildScorecard(CRITERIA, [
    { criterion_id: "a", score: 5, judge_id: "j1" },
    { criterion_id: "a", score: 1, judge_id: "j2" },
    { criterion_id: "a", score: 3, judge_id: "j3" },
  ]);
  assert.equal(card.rows[0].average, 3);
  assert.equal(card.judgeCount, 3);
  // Only criterion "a" was scored, so it carries the whole score: 3/5 = 60%.
  assert.ok(Math.abs(card.weightedPct! - 60) < 1e-9);
});

test("max_score is normalized away, so a 0-10 criterion is worth its weight", () => {
  // Full marks on the 0–5 criterion, half marks on the 0–10 one, equal weight
  // after normalization would give (100% * 20 + 50% * 50) / 70 = 64.28…%.
  const card = buildScorecard(CRITERIA, [
    { criterion_id: "a", score: 5, judge_id: "j1" },
    { criterion_id: "c", score: 5, judge_id: "j1" },
  ]);
  const expected = ((1 * 20 + 0.5 * 50) / 70) * 100;
  assert.ok(Math.abs(card.weightedPct! - expected) < 1e-9);
});

test("criteria nobody scored neither help nor hurt the weighted score", () => {
  const scoredOnly = buildScorecard(
    [CRITERIA[0]],
    [{ criterion_id: "a", score: 4, judge_id: "j1" }],
  );
  const withUnscored = buildScorecard(CRITERIA, [
    { criterion_id: "a", score: 4, judge_id: "j1" },
  ]);
  assert.equal(withUnscored.weightedPct, scoredOnly.weightedPct);
  assert.equal(withUnscored.scoredCount, 1);
});

test("weightPct reports each criterion's share of the whole rubric", () => {
  const card = buildScorecard(CRITERIA, []);
  assert.deepEqual(
    card.rows.map((r) => Math.round(r.weightPct)),
    [20, 30, 50],
  );
});

test("comments are collected per criterion and blanks dropped", () => {
  const card = buildScorecard(CRITERIA, [
    { criterion_id: "a", score: 4, comment: "  tight problem  ", judge_id: "j1" },
    { criterion_id: "a", score: 2, comment: "   ", judge_id: "j2" },
    { criterion_id: "a", score: 3, comment: null, judge_id: "j3" },
  ]);
  assert.deepEqual(card.rows[0].comments, ["tight problem"]);
});

test("a criterion pinned to a cohort only applies to that cohort's teams", () => {
  const all = [
    { id: "g", cohort_id: null },
    { id: "c1", cohort_id: "cohort-1" },
    { id: "c2", cohort_id: "cohort-2" },
  ];
  assert.deepEqual(
    applicableCriteria(all, "cohort-1").map((c) => c.id),
    ["g", "c1"],
  );
  assert.deepEqual(applicableCriteria(all, null).map((c) => c.id), ["g"]);
});

test("the anchor shown is the highest band at or below the rounded average", () => {
  const anchors = [
    { level: 5, label: "five" },
    { level: 3, label: "three" },
    { level: 1, label: "one" },
  ];
  assert.equal(anchorForScore(anchors, 5), "five");
  assert.equal(anchorForScore(anchors, 4.6), "five");
  assert.equal(anchorForScore(anchors, 4.4), "three");
  assert.equal(anchorForScore(anchors, 1), "one");
  // Below the lowest written band there is nothing honest to say.
  assert.equal(anchorForScore(anchors, 0), null);
  assert.equal(anchorForScore(anchors, null), null);
  assert.equal(anchorForScore([], 4), null);
});

test("anchors survive a round trip through the editor's text form", () => {
  const anchors = DEFAULT_PITCH_RUBRIC[0].anchors;
  assert.deepEqual(parseAnchorLines(anchorsToText(anchors)), anchors);
});

test("anchor parsing tolerates the ways people actually type a rubric", () => {
  const parsed = parseAnchorLines(
    [
      "",
      "Scoring guide",
      "5 = top band",
      "4: second band",
      "3 — third band",
      "2. fourth band",
      "5 = a duplicate that loses to the first",
      "nonsense with no level",
    ].join("\n"),
  );
  assert.deepEqual(parsed, [
    { level: 5, label: "top band" },
    { level: 4, label: "second band" },
    { level: 3, label: "third band" },
    { level: 2, label: "fourth band" },
  ]);
});

test("anchors out of the database are narrowed, not trusted", () => {
  assert.deepEqual(coerceAnchors(null), []);
  assert.deepEqual(coerceAnchors("5 = nope"), []);
  assert.deepEqual(
    coerceAnchors([
      { level: 2, label: " low " },
      { level: "4", label: "mid" },
      { level: 5 },
      { label: "no level" },
      null,
      { level: 1, label: "   " },
    ]),
    [
      { level: 4, label: "mid" },
      { level: 2, label: "low" },
    ],
  );
});

test("scores format to one decimal only when they need it", () => {
  assert.equal(formatScore(null, 5), "—");
  assert.equal(formatScore(4, 5), "4 / 5");
  assert.equal(formatScore(4.25, 5), "4.3 / 5");
  assert.equal(formatScore(3.5, 10), "3.5 / 10");
});
