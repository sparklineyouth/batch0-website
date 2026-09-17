// ---------------------------------------------------------------------------
// Scholarship award arithmetic and eligibility rules.
//
// Every number that decides what a student pays — or gets back — is computed
// here, by a pure function over plain data. lib/scholarships.ts owns the
// database; this owns the maths. The split exists because these are the rules
// that must never be wrong twice: the checkout route, the accepted page, the
// admin review screen and the refund button all have to agree on "what is this
// award worth", and the only way to guarantee that is for all four to call the
// same function rather than each doing its own `Math.min`.
//
// IMPORT-FREE ON PURPOSE — same contract as lib/question-schema.ts. `npm test`
// runs this through Node's native type stripping, and the admin editor imports
// it into a client component to preview an award before saving.
// ---------------------------------------------------------------------------

/**
 * What a scholarship is for. Drives copy, the review queue's grouping, and
 * which extra questions the student is asked.
 *
 *   need    — money off tuition, decided on financial circumstances.
 *   merit   — money off tuition, decided on the answers to extra questions.
 *   learner — no money; a grant of perks (extra 1:1 mentor calls and the like).
 *
 * The kind is deliberately NOT what decides the payout: the terms are. A merit
 * scholarship that grants mentor calls instead of money is a perfectly
 * reasonable thing to want, and hard-wiring kind→payout would make it
 * impossible to create without a deploy.
 */
export type ScholarshipKind = "need" | "merit" | "learner";

export const SCHOLARSHIP_KINDS: readonly ScholarshipKind[] = Object.freeze([
  "need",
  "merit",
  "learner",
]);

export const SCHOLARSHIP_KIND_LABELS: Readonly<
  Record<ScholarshipKind, string>
> = Object.freeze({
  need: "Need-based",
  merit: "Merit",
  learner: "Learner's",
});

export const SCHOLARSHIP_KIND_BLURBS: Readonly<
  Record<ScholarshipKind, string>
> = Object.freeze({
  need: "Tuition support based on what your family can afford.",
  merit: "Tuition support based on what you've built and what you answer.",
  learner: "Extra mentor time and tools for students who'll use them.",
});

/**
 * A one-word summary of what an award pays out — DERIVED from the terms, never
 * chosen on its own (see awardTypeOf). Stored on the row for the catalog's
 * grouping and for older readers; the terms are the source of truth.
 *
 *   discount — money off tuition and nothing else.
 *   perks    — no money: one or more of the perks below.
 *   both     — money off tuition AND perks.
 *
 * "mentor_calls" is what a perks-only scholarship was called before 0074,
 * when the only perk was mentor calls. Rows still carrying it read as "perks".
 */
export type AwardType = "discount" | "perks" | "both";

export const AWARD_TYPES: readonly AwardType[] = Object.freeze([
  "discount",
  "perks",
  "both",
]);

// ---------------------------------------------------------------------------
// Perks — the things a scholarship can carry that aren't money (0074)
// ---------------------------------------------------------------------------

/**
 * The perks a scholarship can carry, each ticked on or off per scholarship and
 * stackable with a tuition discount or offered on their own.
 *
 * Every field is a number or a flag some code actually reads — mentor calls by
 * the call-request path, feedback credits by the credit ceiling, guest tickets
 * by the ticket sender, the boost by AI billing. AWARD_PERK_DEFS names where
 * each one bites.
 */
export type AwardPerks = {
  /** Extra 1:1 mentor calls, spent when the team schedules one. */
  mentorCalls: number;
  /** Written feedback credits — the same pool a founder pass draws on. */
  feedbackCredits: number;
  /** Complimentary Demo Day tickets the student can send to guests. */
  demoDayTickets: number;
  /** Multiplies the AI co-founder's free monthly allowance. */
  aiBoost: boolean;
};

export type AwardPerkKey = keyof AwardPerks;

export const NO_PERKS: Readonly<AwardPerks> = Object.freeze({
  mentorCalls: 0,
  feedbackCredits: 0,
  demoDayTickets: 0,
  aiBoost: false,
});

export const MAX_MENTOR_CALLS = 20;
export const MAX_FEEDBACK_CREDITS = 10;
export const MAX_DEMO_DAY_TICKETS = 10;

/**
 * How much the AI boost multiplies the free monthly token allowance by. Read
 * by lib/ai/usage.ts when billing overage and by the usage meter, so the
 * number a student sees and the number they're billed against agree.
 */
export const AI_BOOST_MULTIPLIER = 2;

export type AwardPerkDef =
  | {
      key: "mentorCalls" | "feedbackCredits" | "demoDayTickets";
      kind: "count";
      label: string;
      /** One line for the admin form: what ticking this actually does. */
      blurb: string;
      /** Singular noun for the "how many" box. */
      unit: string;
      /** Ceiling. Keep in lockstep with the check constraints in 0074. */
      max: number;
    }
  | {
      key: "aiBoost";
      kind: "flag";
      label: string;
      blurb: string;
    };

/**
 * The roster the admin form renders as checkboxes, in display order. A
 * "count" perk asks how many once ticked; a "flag" perk is on or off.
 *
 * Adding one means: a column in a migration (on scholarships AND the awarded
 * snapshot on scholarship_applications), a field on AwardPerks, a case in
 * normalizePerks / perkSummaries below, and — the part that matters — a reader
 * somewhere that fulfils it.
 */
export const AWARD_PERK_DEFS: readonly AwardPerkDef[] = Object.freeze([
  {
    key: "mentorCalls",
    kind: "count",
    label: "Extra 1:1 mentor calls",
    blurb:
      "Booked by the student from their calls page. A credit is spent when the team schedules the call, and comes back if it's cancelled.",
    unit: "call",
    max: MAX_MENTOR_CALLS,
  },
  {
    key: "feedbackCredits",
    kind: "count",
    label: "Feedback credits",
    blurb:
      "Focused, written reviews from the team of the thing they're stuck on — the same credit a founder pass carries, redeemed from their scholarship page.",
    unit: "credit",
    max: MAX_FEEDBACK_CREDITS,
  },
  {
    key: "demoDayTickets",
    kind: "count",
    label: "Demo Day guest tickets",
    blurb:
      "Complimentary tickets the student sends to family or friends by email. Each one is a real ticket in the Demo Day ticket list.",
    unit: "ticket",
    max: MAX_DEMO_DAY_TICKETS,
  },
  {
    key: "aiBoost",
    kind: "flag",
    label: "AI co-founder boost",
    blurb: `${AI_BOOST_MULTIPLIER}× the free monthly AI allowance before any overage is billed.`,
  },
]);

const PERK_DEF_BY_KEY: ReadonlyMap<string, AwardPerkDef> = new Map(
  AWARD_PERK_DEFS.map((d) => [d.key, d]),
);

export function awardPerkDef(key: string): AwardPerkDef | undefined {
  return PERK_DEF_BY_KEY.get(key);
}

/** Perks as they arrive — a form payload, a database row — before checking. */
export type AwardPerksInput = {
  mentorCalls?: unknown;
  feedbackCredits?: unknown;
  demoDayTickets?: unknown;
  aiBoost?: unknown;
};

/** A non-negative whole number clamped to a ceiling; 0 for junk. */
function clampCount(value: unknown, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, Math.floor(n));
}

/**
 * Coerce whatever arrived into an AwardPerks safe to store and to render.
 *
 * Junk lands on "no perk", never on a ceiling: a stray string in the mentor
 * calls box must not hand someone twenty calls. Counts are clamped to the
 * same ceilings the 0074 check constraints enforce, so a write that passed
 * through here can never be rejected by the database for being too large.
 */
export function normalizePerks(
  input: AwardPerksInput | null | undefined,
): AwardPerks {
  return {
    mentorCalls: clampCount(input?.mentorCalls, MAX_MENTOR_CALLS),
    feedbackCredits: clampCount(input?.feedbackCredits, MAX_FEEDBACK_CREDITS),
    demoDayTickets: clampCount(input?.demoDayTickets, MAX_DEMO_DAY_TICKETS),
    aiBoost: input?.aiBoost === true,
  };
}

export function hasAnyPerk(perks: AwardPerks): boolean {
  return (
    perks.mentorCalls > 0 ||
    perks.feedbackCredits > 0 ||
    perks.demoDayTickets > 0 ||
    perks.aiBoost
  );
}

/**
 * Each granted perk as a short phrase, in roster order — "3 extra mentor
 * calls", "1 feedback credit", "2 Demo Day guest tickets", "AI co-founder
 * boost". Empty when nothing is granted. Cards, emails and the review screen
 * all print from this so they can't describe the same award three ways.
 */
export function perkSummaries(perks: AwardPerks): string[] {
  const out: string[] = [];
  const n = (count: number, one: string, many: string) =>
    count === 1 ? `1 ${one}` : `${count} ${many}`;
  if (perks.mentorCalls > 0) {
    out.push(n(perks.mentorCalls, "extra mentor call", "extra mentor calls"));
  }
  if (perks.feedbackCredits > 0) {
    out.push(n(perks.feedbackCredits, "feedback credit", "feedback credits"));
  }
  if (perks.demoDayTickets > 0) {
    out.push(
      n(perks.demoDayTickets, "Demo Day guest ticket", "Demo Day guest tickets"),
    );
  }
  if (perks.aiBoost) out.push("AI co-founder boost");
  return out;
}

/** What to multiply the free monthly AI allowance by: 1 without the boost. */
export function perkAiAllowanceMultiplier(
  perks: AwardPerks | null | undefined,
): number {
  return perks?.aiBoost ? AI_BOOST_MULTIPLIER : 1;
}

/** Where in their journey a student may apply for a scholarship. */
export type EligibleStage = "accepted" | "enrolled";

export const ELIGIBLE_STAGES: readonly EligibleStage[] = Object.freeze([
  "accepted",
  "enrolled",
]);

/** The lifecycle of one student's scholarship application. */
export type ScholarshipAppStatus =
  | "draft"
  | "submitted"
  | "under_review"
  | "awarded"
  | "declined"
  | "withdrawn";

export const SCHOLARSHIP_APP_STATUSES: readonly ScholarshipAppStatus[] =
  Object.freeze([
    "draft",
    "submitted",
    "under_review",
    "awarded",
    "declined",
    "withdrawn",
  ]);

/** Statuses that occupy a seat and block a second application. */
export const LIVE_SCHOLARSHIP_STATUSES: readonly ScholarshipAppStatus[] =
  Object.freeze(["submitted", "under_review", "awarded"]);

/** How a money award actually reached the student. */
export type Fulfillment =
  | "none" // nothing owed yet, or a calls-only award
  | "discount" // came off the Stripe checkout they hadn't paid yet
  | "refund_due" // they'd already paid; an admin still has to press the button
  | "refunded"; // the partial refund went through

// ---------------------------------------------------------------------------
// The award itself
// ---------------------------------------------------------------------------

/**
 * The terms a scholarship offers, as stored on the `scholarships` row.
 *
 * Money and perks are independent halves: a scholarship can carry either or
 * both, and awardTypeOf() says which. `amountCents` and `percent` are
 * alternatives within the money half, not a stack: percent wins when it is
 * set. Both exist because both are things people actually want to offer —
 * "$50 off" and "half tuition" — and expressing the second as a cents figure
 * means it silently stops being half the moment tuition changes.
 */
export type AwardTerms = {
  amountCents: number;
  /** 1–100, or null when the award is a flat amount. */
  percent: number | null;
  perks: AwardPerks;
};

/** Whether the money half of these terms is worth anything. */
export function hasMoney(terms: AwardTerms): boolean {
  return terms.percent !== null || normalizeCents(terms.amountCents) > 0;
}

/**
 * The derived summary of what an award pays out. "discount" for money alone,
 * "perks" for perks alone, "both" for both. Terms with neither are a
 * scholarship worth nothing, which the form and the 0074 constraint refuse;
 * they read as "discount" here only so the type stays total.
 */
export function awardTypeOf(terms: AwardTerms): AwardType {
  const money = hasMoney(terms);
  const perks = hasAnyPerk(terms.perks);
  if (money && perks) return "both";
  if (perks) return "perks";
  return "discount";
}

/** Clamp to a whole, non-negative number of cents. */
export function normalizeCents(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** Clamp a percentage to 1–100, or null. */
export function normalizePercent(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(100, Math.floor(n));
}

/** Clamp a mentor-call grant to 0..MAX_MENTOR_CALLS. */
export function normalizeMentorCalls(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_MENTOR_CALLS, Math.floor(n));
}

/**
 * What this scholarship takes off `priceCents`.
 *
 * `priceCents` must already have regional pricing, the site promo and any
 * founder-pass discount applied — a scholarship is the LAST discount in the
 * stack, so "50% off" means half of what the student would otherwise have
 * actually been billed, not half the US list price. Ordering it last is what
 * stops a full-ride pass holder plus a 50% scholarship from producing a
 * negative balance.
 *
 * Returns 0 for a perks-only award.
 */
export function awardDiscountCents(
  terms: AwardTerms,
  priceCents: number,
): number {
  if (!hasMoney(terms)) return 0;
  const price = normalizeCents(priceCents);
  if (price <= 0) return 0;
  const raw =
    terms.percent !== null
      ? Math.round((price * terms.percent) / 100)
      : normalizeCents(terms.amountCents);
  // Never more than the student owes. A $200 award against a $130 balance is
  // a $130 award, not a $70 payment to the student.
  return Math.max(0, Math.min(price, raw));
}

/**
 * What an already-paid student gets back, in cents.
 *
 * Deliberately a separate function from awardDiscountCents even though the
 * arithmetic rhymes, because the input differs in a way that matters: a refund
 * is bounded by what they ACTUALLY PAID (the `payments` row), not by the
 * current list price. Someone who paid $97 during a sale and is later given a
 * "full tuition" scholarship gets $97 back — computing it off today's $130
 * headline would refund $33 that never arrived.
 */
export function awardRefundCents(
  terms: AwardTerms,
  paidCents: number,
  alreadyRefundedCents = 0,
): number {
  if (!hasMoney(terms)) return 0;
  const paid = normalizeCents(paidCents);
  const already = normalizeCents(alreadyRefundedCents);
  const remaining = Math.max(0, paid - already);
  if (remaining <= 0) return 0;
  const raw =
    terms.percent !== null
      ? Math.round((paid * terms.percent) / 100)
      : normalizeCents(terms.amountCents);
  return Math.max(0, Math.min(remaining, raw));
}

/**
 * How an award should be fulfilled, given where the student is.
 *
 * The one place that decides "discount it or refund it", so the admin screen's
 * button and the checkout route can never disagree about which mechanism
 * applies to a given student.
 */
export function fulfillmentFor(
  terms: AwardTerms,
  args: { hasPaid: boolean; refundedCents?: number },
): Fulfillment {
  if (!hasMoney(terms)) return "none";
  if (!args.hasPaid) return "discount";
  return normalizeCents(args.refundedCents) > 0 ? "refunded" : "refund_due";
}

/** The money half as a phrase, or null when there is none. */
export function describeMoney(terms: AwardTerms): string | null {
  if (!hasMoney(terms)) return null;
  if (terms.percent !== null) return `${terms.percent}% off tuition`;
  return `${formatMoney(terms.amountCents)} off tuition`;
}

/**
 * A short human summary of the terms, for cards and emails: the money, then
 * each perk — "$50 off tuition · 3 extra mentor calls · AI co-founder boost".
 * One string, so a card never has to decide how to lay it out.
 */
export function describeAward(terms: AwardTerms): string {
  const parts = [describeMoney(terms), ...perkSummaries(terms.perks)].filter(
    (p): p is string => !!p,
  );
  return parts.length ? parts.join(" · ") : "Nothing yet";
}

/** `$130`, `$12.50`. Whole dollars drop the cents — the house style. */
export function formatMoney(cents: number): string {
  const n = normalizeCents(cents);
  const dollars = n / 100;
  return n % 100 === 0
    ? `$${dollars.toFixed(0)}`
    : `$${dollars.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * The student-side facts eligibility is decided on. Everything the caller
 * already knows from `applications` + `enrollments`, and nothing it doesn't —
 * so this stays a pure function.
 */
export type ApplicantState = {
  /** The student's `applications.status`. */
  applicationStatus: string | null;
  /** True once they hold an `enrollments` row (i.e. tuition is paid/waived). */
  enrolled: boolean;
  /** Live scholarship applications this student already holds. */
  liveStatuses: readonly ScholarshipAppStatus[];
};

/**
 * Which stage a student counts as for eligibility, or null if neither.
 *
 * Enrolled wins over accepted: a student who has paid is enrolled, and their
 * `applications.status` also reads 'enrolled', so checking enrolment first
 * keeps the two from disagreeing.
 */
export function stageOf(state: ApplicantState): EligibleStage | null {
  if (state.enrolled) return "enrolled";
  const s = state.applicationStatus;
  if (s === "enrolled" || s === "paid") return "enrolled";
  if (s === "accepted") return "accepted";
  return null;
}

export type Eligibility =
  | { ok: true; stage: EligibleStage }
  | { ok: false; reason: EligibilityDenial; message: string };

export type EligibilityDenial =
  | "closed" // disabled, or outside its window
  | "full" // every seat taken
  | "stage" // not accepted/enrolled yet, or the wrong stage for this one
  | "already_applied" // they have a live application to THIS scholarship
  | "holds_award"; // the one-at-a-time rule

/** The scholarship-side facts eligibility is decided on. */
export type ScholarshipOffer = {
  name: string;
  enabled: boolean;
  opensAt: string | null;
  closesAt: string | null;
  /** null = unlimited. */
  seats: number | null;
  awardedCount: number;
  eligibleStages: readonly EligibleStage[];
};

/**
 * Whether `state` may apply to `offer` right now.
 *
 * `now` is passed in rather than read from the clock so the same call is
 * testable and so a server render and its subsequent action agree on the
 * moment. Denials carry applicant-facing copy: this text is shown directly on
 * the dashboard card, so it explains rather than just refusing.
 */
export function checkEligibility(
  offer: ScholarshipOffer,
  state: ApplicantState,
  now: Date,
  opts: { alreadyAppliedHere?: boolean } = {},
): Eligibility {
  if (!offer.enabled) {
    return { ok: false, reason: "closed", message: "This scholarship isn't open right now." };
  }

  const t = now.getTime();
  if (offer.opensAt) {
    const opens = Date.parse(offer.opensAt);
    if (Number.isFinite(opens) && t < opens) {
      return { ok: false, reason: "closed", message: "This scholarship hasn't opened yet." };
    }
  }
  if (offer.closesAt) {
    const closes = Date.parse(offer.closesAt);
    if (Number.isFinite(closes) && t > closes) {
      return { ok: false, reason: "closed", message: "Applications for this scholarship have closed." };
    }
  }

  if (offer.seats !== null && offer.awardedCount >= offer.seats) {
    return { ok: false, reason: "full", message: "Every spot on this scholarship has been awarded." };
  }

  const stage = stageOf(state);
  if (!stage) {
    return {
      ok: false,
      reason: "stage",
      message: "Scholarships open up once you've been accepted.",
    };
  }
  if (!offer.eligibleStages.includes(stage)) {
    return {
      ok: false,
      reason: "stage",
      message:
        stage === "enrolled"
          ? "This scholarship is only open before you enroll."
          : "This scholarship opens once you've enrolled.",
    };
  }

  // The one-at-a-time rule. Checked before already_applied so that a student
  // holding an award elsewhere gets told WHY rather than being shown a
  // confusing "you've already applied" on a scholarship they never touched.
  if (state.liveStatuses.includes("awarded")) {
    return {
      ok: false,
      reason: "holds_award",
      message: "You already hold a batch0 scholarship — only one per student.",
    };
  }

  if (opts.alreadyAppliedHere) {
    return {
      ok: false,
      reason: "already_applied",
      message: "You've already applied to this scholarship.",
    };
  }

  // A pending application elsewhere also blocks: letting someone queue up five
  // and take whichever lands first would make the seat counts meaningless.
  if (state.liveStatuses.some((s) => s === "submitted" || s === "under_review")) {
    return {
      ok: false,
      reason: "holds_award",
      message:
        "You have a scholarship application under review. You can apply to another once it's decided.",
    };
  }

  return { ok: true, stage };
}

/**
 * Whether an admin may award this application right now.
 *
 * Mirrors checkEligibility's one-at-a-time rule from the other side, because
 * the student's situation can change between applying and being reviewed —
 * they may have been awarded something else in the meantime. Returns an
 * admin-facing message, not applicant copy.
 */
export function canAward(args: {
  status: ScholarshipAppStatus;
  /** Live statuses on this student's OTHER scholarship applications. */
  otherLiveStatuses: readonly ScholarshipAppStatus[];
  seats: number | null;
  awardedCount: number;
}): { ok: true } | { ok: false; error: string } {
  if (args.status === "awarded") {
    return { ok: false, error: "This application is already awarded." };
  }
  if (args.status === "withdrawn") {
    return { ok: false, error: "The student withdrew this application." };
  }
  if (args.status === "draft") {
    return { ok: false, error: "This application hasn't been submitted yet." };
  }
  if (args.otherLiveStatuses.includes("awarded")) {
    return {
      ok: false,
      error:
        "This student already holds another scholarship. Revoke that one first — students hold one at a time.",
    };
  }
  if (args.seats !== null && args.awardedCount >= args.seats) {
    return {
      ok: false,
      error: "Every seat on this scholarship is already awarded. Add a seat first.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Mentor-call credits (the learner's scholarship)
// ---------------------------------------------------------------------------

export type CallCredits = {
  granted: number;
  used: number;
  remaining: number;
};

/**
 * The credit balance on an award.
 *
 * `used` is clamped to `granted` rather than allowed to exceed it. It can
 * legitimately overshoot — an admin can lower a grant after calls have been
 * booked — and a negative `remaining` rendered as "-1 calls left" is worse
 * than showing zero, since the booking path already refuses at zero.
 */
export function callCredits(
  granted: unknown,
  used: unknown,
): CallCredits {
  const g = normalizeMentorCalls(granted);
  const u = Math.max(0, Math.min(g, Math.floor(Number(used) || 0)));
  return { granted: g, used: u, remaining: g - u };
}

/** Whether this award can still book a scholarship-funded mentor call. */
export function canBookCall(credits: CallCredits): boolean {
  return credits.remaining > 0;
}
