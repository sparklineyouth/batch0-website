// ---------------------------------------------------------------------------
// Weekly Challenges — client-safe shared layer.
//
// Pure types, constants, and helpers with NO server-only imports (no admin
// Supabase client, no zod). Safe to import from client components. The
// server-only reads + the zod answer-schema builder live in lib/challenges.ts,
// which re-exports everything here so server callers can keep importing from
// "@/lib/challenges".
// ---------------------------------------------------------------------------

export type ChallengeStatus = "draft" | "active" | "closed" | "archived";

export type ChallengeQuestionType =
  | "short_text"
  | "long_text"
  | "url"
  | "select";

export const CHALLENGE_QUESTION_TYPES: readonly ChallengeQuestionType[] = [
  "short_text",
  "long_text",
  "url",
  "select",
];

export const QUESTION_TYPE_LABELS: Record<ChallengeQuestionType, string> = {
  short_text: "Short text",
  long_text: "Long text",
  url: "Link / URL",
  select: "Multiple choice",
};

/** One admin-authored question. `id` is a stable, persisted key that answers
 *  are stored under — never regenerate it once questions exist. */
export type ChallengeQuestion = {
  id: string;
  type: ChallengeQuestionType;
  label: string;
  help: string;
  placeholder: string;
  required: boolean;
  /** For `select` only: the allowed option values (also shown as labels). */
  options: string[];
};

/** Stored answers: question id -> the applicant's answer. */
export type ChallengeAnswers = Record<string, string>;

export type Challenge = {
  id: string;
  slug: string;
  title: string;
  description: string;
  prizeLabel: string;
  prizeAmountCents: number | null;
  marqueeText: string;
  ctaLabel: string;
  ctaHref: string | null;
  status: ChallengeStatus;
  opensAt: string | null;
  closesAt: string | null;
  questions: ChallengeQuestion[];
  winnersPublished: boolean;
  createdAt: string;
  updatedAt: string;
};

/** A submission as the admin review UI needs it. */
export type ChallengeSubmission = {
  id: string;
  challengeId: string;
  userId: string;
  answers: ChallengeAnswers;
  questionsSnapshot: ChallengeQuestion[];
  status: "submitted" | "shortlisted" | "funded" | "rejected" | "withdrawn";
  payoutAmountCents: number | null;
  reviewNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  referralCode: string | null;
  winnerPublic: boolean;
  publicName: string | null;
  publicBlurb: string | null;
  publicProjectUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A row from the PII-safe challenge_winners_public view. */
export type PublicWinner = {
  id: string;
  challengeSlug: string;
  challengeTitle: string;
  publicName: string | null;
  publicBlurb: string | null;
  publicProjectUrl: string | null;
  payoutAmountCents: number | null;
  fundedAt: string | null;
};

// --- Guardrails -----------------------------------------------------------
export const MAX_QUESTIONS = 12;
export const MAX_OPTIONS = 20;
export const SHORT_TEXT_MAX = 300;
export const LONG_TEXT_MAX = 4000;
export const URL_MAX = 500;
/** Same rule the cohort application uses for URL fields. */
export const HTTP_URL_RE = /^https?:\/\/.+/;

export function isQuestionType(v: unknown): v is ChallengeQuestionType {
  return (
    typeof v === "string" &&
    (CHALLENGE_QUESTION_TYPES as readonly string[]).includes(v)
  );
}

/**
 * Coerce an arbitrary jsonb value into a clean ChallengeQuestion[]. Drops
 * malformed entries, caps counts, and (for `select`) drops empty options.
 * Used on every read so a bad `questions` blob can't break the apply page.
 */
export function sanitizeQuestions(
  raw: unknown,
  opts: { assignMissingIds?: boolean } = {},
): ChallengeQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ChallengeQuestion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_QUESTIONS) break;
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (!isQuestionType(rec.type)) continue;

    let id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) {
      if (!opts.assignMissingIds) continue;
      id = newQuestionId();
    }
    if (seen.has(id)) continue; // no duplicate keys
    seen.add(id);

    const label = typeof rec.label === "string" ? rec.label.trim() : "";
    if (!label) continue; // a question needs a prompt

    let options: string[] = [];
    if (rec.type === "select") {
      const rawOpts = Array.isArray(rec.options) ? rec.options : [];
      options = rawOpts
        .filter((o): o is string => typeof o === "string")
        .map((o) => o.trim())
        .filter((o) => o.length > 0)
        .slice(0, MAX_OPTIONS);
      if (options.length === 0) continue; // a choice needs choices
    }

    out.push({
      id,
      type: rec.type,
      label,
      help: typeof rec.help === "string" ? rec.help : "",
      placeholder: typeof rec.placeholder === "string" ? rec.placeholder : "",
      required: rec.required === true,
      options,
    });
  }
  return out;
}

/** Generate a stable id for a new question. Safe in the browser and Node
 *  (both expose crypto.randomUUID); the catch keeps it from ever throwing. */
export function newQuestionId(): string {
  try {
    return crypto.randomUUID().slice(0, 12);
  } catch {
    return `q_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}

function rowToChallenge(row: any): Challenge {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: typeof row.description === "string" ? row.description : "",
    prizeLabel: typeof row.prize_label === "string" ? row.prize_label : "",
    prizeAmountCents:
      typeof row.prize_amount_cents === "number"
        ? row.prize_amount_cents
        : null,
    marqueeText: typeof row.marquee_text === "string" ? row.marquee_text : "",
    ctaLabel:
      typeof row.cta_label === "string" && row.cta_label.trim()
        ? row.cta_label
        : "Apply",
    ctaHref:
      typeof row.cta_href === "string" && row.cta_href ? row.cta_href : null,
    status: (row.status as ChallengeStatus) ?? "draft",
    opensAt: typeof row.opens_at === "string" ? row.opens_at : null,
    closesAt: typeof row.closes_at === "string" ? row.closes_at : null,
    questions: sanitizeQuestions(row.questions),
    winnersPublished: row.winners_published === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToSubmission(row: any): ChallengeSubmission {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    userId: row.user_id,
    answers:
      row.answers &&
      typeof row.answers === "object" &&
      !Array.isArray(row.answers)
        ? (row.answers as ChallengeAnswers)
        : {},
    questionsSnapshot: sanitizeQuestions(row.questions_snapshot),
    status: row.status,
    payoutAmountCents:
      typeof row.payout_amount_cents === "number"
        ? row.payout_amount_cents
        : null,
    reviewNotes: typeof row.review_notes === "string" ? row.review_notes : null,
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at ?? null,
    referralCode: row.referral_code ?? null,
    winnerPublic: row.winner_public === true,
    publicName: row.public_name ?? null,
    publicBlurb: row.public_blurb ?? null,
    publicProjectUrl: row.public_project_url ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { rowToChallenge };

/** The challenge is open for submissions right now. */
export function isChallengeOpen(challenge: Challenge, now = Date.now()): boolean {
  if (challenge.status !== "active") return false;
  if (challenge.opensAt && new Date(challenge.opensAt).getTime() > now) {
    return false;
  }
  if (challenge.closesAt && new Date(challenge.closesAt).getTime() < now) {
    return false;
  }
  return true;
}

/** "$500" from cents, or "" when null. Shared by admin + public surfaces. */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  const dollars = cents / 100;
  return dollars % 1 === 0
    ? `$${dollars.toLocaleString("en-US")}`
    : `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
