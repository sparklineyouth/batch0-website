/**
 * The Demo Day rubric: the canonical five criteria, and the pure maths that
 * turns a pile of judge scores into one scorecard.
 *
 * Two things live here on purpose.
 *
 * THE CONTENT. `DEFAULT_PITCH_RUBRIC` is the rubric we actually use — five
 * criteria, each weighted as a share of 100, each scored 0–5 against written
 * anchors. The anchors are the whole point: "4/5 on traction" means nothing
 * across eight judges who have never met, while "early real usage or one
 * paying pilot, small but honestly stated" means roughly the same thing to
 * all of them. Judges read the anchor next to the number they're about to
 * click, and founders read the anchor they landed on when the feedback comes
 * back — so the same sentence does the calibrating and the explaining.
 *
 * THE MATHS. Scores are averaged per criterion across judges, normalized to
 * that criterion's max, then weighted. Normalizing before weighting is what
 * lets an admin set one criterion to 0–10 without silently doubling its
 * influence on the leaderboard.
 *
 * Both halves are pure and dependency-free so the aggregation can be unit
 * tested and reused by the admin leaderboard, the release flow, the email and
 * the founders' dashboard without four subtly different versions of "what did
 * this team score".
 */

export type RubricAnchor = {
  /** The score this sentence describes. */
  level: number;
  /** What that score looks like, in one sentence a judge can check against. */
  label: string;
};

export type RubricCriterionSpec = {
  label: string;
  /** The hint judges see while scoring. */
  description: string;
  /** Share of the total score. The defaults are percentages summing to 100. */
  weight: number;
  max_score: number;
  anchors: RubricAnchor[];
};

/**
 * The five criteria. Ordered the way a pitch unfolds — problem, product,
 * proof, business, delivery — so a judge scoring live moves down the card in
 * step with the team on stage.
 *
 * Weights are percentages that sum to 100, which is a convention rather than
 * a constraint: the maths below normalizes by whatever the weights add up to,
 * so an admin who edits one of them doesn't have to rebalance the rest. But
 * keeping them at 100 means "25" reads as "a quarter of the score" in the
 * editor, in the judge's card and in the founders' feedback alike.
 */
export const DEFAULT_PITCH_RUBRIC: RubricCriterionSpec[] = [
  {
    label: "Problem & insight",
    description:
      "Is the problem real, specific and painful for a named group of people — and does the team know something about it that isn't obvious from the outside?",
    weight: 20,
    max_score: 5,
    anchors: [
      {
        level: 5,
        label:
          "Names a specific person with a frequent, painful problem, backed by what real users told them, and offers a non-obvious insight that reframes it.",
      },
      {
        level: 4,
        label:
          "Real, specific problem with some first-hand user evidence; the insight is sound but one an outsider could have reached.",
      },
      {
        level: 3,
        label:
          "Plausible problem described generically (\"students are stressed\"); the pain is asserted rather than evidenced.",
      },
      {
        level: 2,
        label:
          "A category, not a pain — no sign the people described actually feel it, or who they are.",
      },
      {
        level: 1,
        label:
          "No real problem stated; the product is in search of one it might solve.",
      },
    ],
  },
  {
    label: "Product & demo",
    description:
      "Does the thing exist and visibly work? Does the demo show the core loop solving that problem, rather than a tour of the settings page?",
    weight: 25,
    max_score: 5,
    anchors: [
      {
        level: 5,
        label:
          "Live demo of the core loop end to end, clearly built by the team, and it's obvious why that loop solves the problem just described.",
      },
      {
        level: 4,
        label:
          "Core path works with rough edges elsewhere; the link between what's shown and the problem is clear.",
      },
      {
        level: 3,
        label:
          "Partially working prototype or a recorded demo; the core loop is implied more than shown.",
      },
      {
        level: 2,
        label:
          "Mock-ups, slides or a figma walkthrough only — unclear what has actually been built.",
      },
      {
        level: 1,
        label: "Nothing shown, or the demo doesn't run.",
      },
    ],
  },
  {
    label: "Traction & evidence",
    description:
      "What has happened in the real world? Users, usage, retention, revenue, pilots, letters of intent — with honest numbers and denominators, not vanity stats.",
    weight: 20,
    max_score: 5,
    anchors: [
      {
        level: 5,
        label:
          "Real users beyond friends and family, with usage or retention over several weeks, or revenue — stated with honest denominators and a visible trend.",
      },
      {
        level: 4,
        label:
          "Early real usage, a signed pilot or a first paying customer: small numbers, clearly and honestly stated.",
      },
      {
        level: 3,
        label:
          "Interviews, signups or a waitlist only — evidence of interest, not of use.",
      },
      {
        level: 2,
        label:
          "Vanity metrics (views, followers, \"lots of interest\") or numbers with no denominator.",
      },
      {
        level: 1,
        label: "No evidence anyone outside the team has used or wanted it.",
      },
    ],
  },
  {
    label: "Market & business model",
    description:
      "Who pays, how much, and how many of them are there? Is there a specific wedge to start in, and a believable path out of it?",
    weight: 15,
    max_score: 5,
    anchors: [
      {
        level: 5,
        label:
          "Clear payer and price, market sized bottom-up from real units, a specific wedge to win first, and a credible path from that wedge to something bigger.",
      },
      {
        level: 4,
        label:
          "Payer, price and a sensible wedge are all named; the sizing is roughly right even if top-down.",
      },
      {
        level: 3,
        label:
          "Monetization named but untested, and the market is a headline number lifted from a report.",
      },
      {
        level: 2,
        label:
          "A TAM slide with no mechanism, or revenue deferred to \"later\" with no hypothesis.",
      },
      { level: 1, label: "No payer, no price, no market." },
    ],
  },
  {
    label: "Pitch craft, Q&A & team",
    description:
      "Was the story clear, tight and in time? Did Q&A answers stay direct — knowing their own numbers and risks, and able to say \"I don't know\"? Is this a believable team for this problem?",
    weight: 20,
    max_score: 5,
    anchors: [
      {
        level: 5,
        label:
          "Tight, well-paced story anyone could follow, finished in time, readable slides; Q&A answers are direct and specific, risks named without defensiveness, and the team's skills and shipping speed make them a believable bet.",
      },
      {
        level: 4,
        label:
          "Clear story with a few rough transitions or a slight overrun; Q&A is mostly direct and the division of labour makes sense.",
      },
      {
        level: 3,
        label:
          "Followable but padded or rushed; buzzwords stand in for substance and Q&A answers drift off the question.",
      },
      {
        level: 2,
        label:
          "Hard to follow, well over time, read off the slides; questions dodged or answered with guesses.",
      },
      {
        level: 1,
        label: "Incoherent, or no real answers to anything asked.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export type CriterionRow = {
  id: string;
  label: string;
  description?: string | null;
  weight: number | string;
  max_score: number;
  anchors?: RubricAnchor[] | null;
  cohort_id?: string | null;
  position?: number | null;
};

export type ScoreRow = {
  criterion_id: string;
  score: number;
  comment?: string | null;
  judge_id?: string | null;
};

export type ScorecardRow = {
  criterion: CriterionRow;
  /** Mean across judges who scored this criterion, or null if none did. */
  average: number | null;
  maxScore: number;
  /** This criterion's share of the total weight, as a percentage. */
  weightPct: number;
  judgeCount: number;
  /** The anchor sentence closest at-or-below the rounded average. */
  anchor: string | null;
  /** Judge notes, in no particular order, never attributed. */
  comments: string[];
};

export type Scorecard = {
  rows: ScorecardRow[];
  /** Weighted score across scored criteria, 0–100, or null if unscored. */
  weightedPct: number | null;
  /** How many distinct judges scored anything for this team. */
  judgeCount: number;
  scoredCount: number;
};

/**
 * Criteria that apply to a team. A criterion with no cohort is global; one
 * pinned to a cohort only applies to teams in it.
 */
export function applicableCriteria<T extends { cohort_id?: string | null }>(
  criteria: T[],
  cohortId: string | null | undefined,
): T[] {
  return criteria.filter((c) => !c.cohort_id || c.cohort_id === cohortId);
}

/** The anchor describing a given score: the highest level at or below it. */
export function anchorForScore(
  anchors: RubricAnchor[] | null | undefined,
  score: number | null,
): string | null {
  if (!anchors?.length || score == null) return null;
  const rounded = Math.round(score);
  const sorted = [...anchors].sort((a, b) => b.level - a.level);
  const hit = sorted.find((a) => a.level <= rounded);
  // Below the lowest written anchor (typically a 0) there is nothing honest to
  // say, so say nothing rather than borrowing the bottom band's sentence.
  return hit?.label ?? null;
}

/**
 * One team's scorecard.
 *
 * Averaging per criterion first, then weighting, is deliberate: judges score
 * different subsets of criteria (someone joins late, someone skips the market
 * question), and a flat mean over all rows would quietly let the criterion
 * with the most scores dominate. Normalizing each average by its own
 * `max_score` before applying the weight keeps a 0–10 criterion worth exactly
 * its weight rather than twice it.
 *
 * `weightedPct` divides by the weight of the criteria that were *actually*
 * scored, so a team judged on four of five criteria isn't docked for the
 * fifth. An entirely unscored team gets null, not 0 — "nobody judged this
 * team" and "the judges hated it" must not look the same on a leaderboard.
 */
export function buildScorecard(
  criteria: CriterionRow[],
  scores: ScoreRow[],
): Scorecard {
  const byCriterion = new Map<string, ScoreRow[]>();
  const judges = new Set<string>();
  for (const s of scores) {
    if (s.judge_id) judges.add(s.judge_id);
    const arr = byCriterion.get(s.criterion_id) ?? [];
    arr.push(s);
    byCriterion.set(s.criterion_id, arr);
  }

  const totalWeight = criteria.reduce(
    (sum, c) => sum + Math.max(Number(c.weight) || 0, 0),
    0,
  );

  let weightedSum = 0;
  let scoredWeight = 0;

  const rows: ScorecardRow[] = criteria.map((c) => {
    const mine = byCriterion.get(c.id) ?? [];
    const weight = Math.max(Number(c.weight) || 0, 0);
    const average =
      mine.length > 0
        ? mine.reduce((a, s) => a + s.score, 0) / mine.length
        : null;
    if (average != null && weight > 0) {
      weightedSum += (average / Math.max(c.max_score, 1)) * weight;
      scoredWeight += weight;
    }
    return {
      criterion: c,
      average,
      maxScore: c.max_score,
      weightPct: totalWeight > 0 ? (weight / totalWeight) * 100 : 0,
      judgeCount: mine.length,
      anchor: anchorForScore(c.anchors, average),
      comments: mine
        .map((s) => (s.comment ?? "").trim())
        .filter((t) => t.length > 0),
    };
  });

  return {
    rows,
    weightedPct: scoredWeight > 0 ? (weightedSum / scoredWeight) * 100 : null,
    judgeCount: judges.size,
    scoredCount: rows.filter((r) => r.average != null).length,
  };
}

// ---------------------------------------------------------------------------
// Anchor text <-> structure
// ---------------------------------------------------------------------------

/**
 * Anchors are edited as plain lines — `5 = a live demo of the core loop` —
 * because a repeating sub-form for six bands per criterion is a worse editing
 * experience than a textarea, and because the lines paste cleanly out of a
 * doc where rubrics are usually drafted.
 *
 * Unparseable lines are dropped rather than rejected: a trailing blank line
 * or a stray header shouldn't block saving a rubric an hour before Demo Day.
 */
export function parseAnchorLines(text: string): RubricAnchor[] {
  const out: RubricAnchor[] = [];
  const seen = new Set<number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s*(?:[=:—–-]|\.)\s*(.+)$/.exec(line);
    if (!m) continue;
    const level = Number(m[1]);
    const label = m[2].trim();
    if (!Number.isFinite(level) || !label || seen.has(level)) continue;
    seen.add(level);
    out.push({ level, label });
  }
  return out.sort((a, b) => b.level - a.level);
}

export function anchorsToText(anchors: RubricAnchor[] | null | undefined): string {
  return (anchors ?? [])
    .slice()
    .sort((a, b) => b.level - a.level)
    .map((a) => `${a.level} = ${a.label}`)
    .join("\n");
}

/**
 * Narrows whatever came out of a `jsonb` column into anchors. Hand-edited SQL
 * and older rows both reach this, so anything that isn't a {level, label}
 * pair is discarded rather than trusted into the UI.
 */
export function coerceAnchors(value: unknown): RubricAnchor[] {
  if (!Array.isArray(value)) return [];
  const out: RubricAnchor[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const level = Number((item as any).level);
    const label = (item as any).label;
    if (!Number.isFinite(level) || typeof label !== "string" || !label.trim())
      continue;
    out.push({ level, label: label.trim() });
  }
  return out.sort((a, b) => b.level - a.level);
}

/** Score formatted for display: `4.3 / 5`, or an em dash when unscored. */
export function formatScore(average: number | null, maxScore: number): string {
  if (average == null) return "—";
  const rounded = Math.round(average * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} / ${maxScore}`;
}
