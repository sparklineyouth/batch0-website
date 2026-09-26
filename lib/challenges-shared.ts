// ---------------------------------------------------------------------------
// Challenges (hackathons, weekly challenges, giveaways) — client-safe layer.
//
// Pure types, constants, and helpers with NO server-only imports. Safe to
// import from client components. The server-only reads live in
// lib/challenges.ts, which re-exports everything here so server callers can
// keep importing from "@/lib/challenges".
//
// Every jsonb column (questions, prizes, schedule, faq, resources, answers) is
// run through a sanitize* function on read. The database only promises "an
// array"; these functions are what promise the shape, so a malformed blob can
// degrade one section of a page but never crash it.
// ---------------------------------------------------------------------------

export type ChallengeStatus = "draft" | "active" | "closed" | "archived";

export type ChallengeKind = "hackathon" | "challenge" | "giveaway";
export const CHALLENGE_KINDS: readonly ChallengeKind[] = [
  "hackathon",
  "challenge",
  "giveaway",
];
export const KIND_LABELS: Record<ChallengeKind, string> = {
  hackathon: "Hackathon",
  challenge: "Challenge",
  giveaway: "Giveaway",
};

export type CoverTheme = "phosphor" | "ink" | "paper";
export const COVER_THEMES: readonly CoverTheme[] = ["phosphor", "ink", "paper"];

// --- Questions -------------------------------------------------------------

export type ChallengeQuestionType =
  | "short_text"
  | "long_text"
  | "url"
  | "video"
  | "select"
  | "multi_select"
  | "number"
  | "file"
  | "team"
  | "checkbox"
  | "scale"
  | "section";

export const CHALLENGE_QUESTION_TYPES: readonly ChallengeQuestionType[] = [
  "short_text",
  "long_text",
  "url",
  "video",
  "file",
  "select",
  "multi_select",
  "number",
  "scale",
  "team",
  "checkbox",
  "section",
];

export const QUESTION_TYPE_LABELS: Record<ChallengeQuestionType, string> = {
  short_text: "Short answer",
  long_text: "Paragraph",
  url: "Link",
  video: "Video (link or upload)",
  file: "File upload",
  select: "Single choice",
  multi_select: "Checkboxes (pick many)",
  number: "Number",
  scale: "Scale (1–N)",
  team: "Team members",
  checkbox: "Yes / agree checkbox",
  section: "Section heading",
};

/** What a `file` question accepts. */
export type FileKind = "image" | "document" | "any";
export const FILE_KIND_LABELS: Record<FileKind, string> = {
  image: "Images",
  document: "PDFs & images",
  any: "Any common file",
};

/** One admin-authored question. `id` is a stable, persisted key that answers
 *  are stored under — never regenerate it once questions exist. Fields that
 *  only apply to some types are always present with a neutral default, so the
 *  builder and renderer never branch on "is this key set". */
export type ChallengeQuestion = {
  id: string;
  type: ChallengeQuestionType;
  label: string;
  help: string;
  placeholder: string;
  required: boolean;
  /** select / multi_select: the allowed options (also shown as labels). */
  options: string[];
  /** short_text / long_text: character cap shown as a live counter. */
  maxLength: number | null;
  /** file: what it accepts, and how many. */
  fileKind: FileKind;
  maxFiles: number;
  /** scale: 1..scaleMax, with optional end labels. */
  scaleMax: number;
  scaleMinLabel: string;
  scaleMaxLabel: string;
  /** team: how many teammates besides the submitter. */
  maxTeam: number;
};

/** An uploaded file answer (file questions). */
export type UploadedFile = {
  path: string;
  name: string;
  size: number;
  type: string;
};

/** A teammate listed on a `team` question. */
export type TeamMember = { name: string; email: string };

export type ChallengeAnswerValue =
  | string
  | number
  | boolean
  | string[]
  | UploadedFile[]
  | TeamMember[];

/** Stored answers: question id -> the entrant's answer. */
export type ChallengeAnswers = Record<string, ChallengeAnswerValue>;

// --- Prizes, schedule, FAQ, resources --------------------------------------

export type PrizeKind = "cash" | "item" | "perk";
export const PRIZE_KINDS: readonly PrizeKind[] = ["cash", "item", "perk"];
export const PRIZE_KIND_LABELS: Record<PrizeKind, string> = {
  cash: "Cash",
  item: "Item",
  perk: "Perk",
};

export type ChallengePrize = {
  id: string;
  /** "1st place", "Grand prize", "Best design", "Everyone who submits". */
  place: string;
  kind: PrizeKind;
  /** "$500" for cash is derived from valueCents when blank; for an item it's
   *  the thing itself: "Ray-Ban Meta glasses". */
  title: string;
  description: string;
  /** Cash amount, or an item's retail value (optional). */
  valueCents: number | null;
  /** How many winners get this prize. */
  quantity: number;
  imageUrl: string | null;
};

export type ScheduleItem = {
  id: string;
  at: string; // ISO
  label: string;
  detail: string;
  url: string;
};

export type FaqItem = { id: string; q: string; a: string };
export type ResourceLink = {
  id: string;
  label: string;
  url: string;
  description: string;
};

export type Challenge = {
  id: string;
  slug: string;
  kind: ChallengeKind;
  title: string;
  tagline: string;
  description: string;
  coverImageUrl: string | null;
  coverTheme: CoverTheme;
  location: string;
  locationUrl: string | null;
  prizeLabel: string;
  prizeAmountCents: number | null;
  prizes: ChallengePrize[];
  marqueeText: string;
  ctaLabel: string;
  ctaHref: string | null;
  status: ChallengeStatus;
  opensAt: string | null;
  closesAt: string | null;
  resultsAt: string | null;
  schedule: ScheduleItem[];
  rules: string;
  faq: FaqItem[];
  resources: ResourceLink[];
  questions: ChallengeQuestion[];
  referralsRequired: number;
  allowEdits: boolean;
  featured: boolean;
  winnersPublished: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SubmissionStatus =
  | "draft"
  | "submitted"
  | "shortlisted"
  | "funded"
  | "rejected"
  | "withdrawn";

/** A submission as the admin review UI needs it. */
export type ChallengeSubmission = {
  id: string;
  challengeId: string;
  userId: string;
  answers: ChallengeAnswers;
  questionsSnapshot: ChallengeQuestion[];
  status: SubmissionStatus;
  submittedAt: string | null;
  payoutAmountCents: number | null;
  prizeId: string | null;
  awardLabel: string | null;
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
  awardLabel: string | null;
  fundedAt: string | null;
};

// --- Guardrails -----------------------------------------------------------
export const MAX_QUESTIONS = 30;
export const MAX_OPTIONS = 30;
export const MAX_PRIZES = 20;
export const MAX_SCHEDULE = 20;
export const MAX_FAQ = 30;
export const MAX_RESOURCES = 20;
export const MAX_FILES_PER_QUESTION = 10;
export const MAX_TEAM = 10;
export const SHORT_TEXT_MAX = 300;
export const LONG_TEXT_MAX = 6000;
export const URL_MAX = 500;
export const MAX_REFERRALS_REQUIRED = 50;
/** Same rule the cohort application uses for URL fields. */
export const HTTP_URL_RE = /^https?:\/\/.+/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A `video` answer is stored as EITHER a normal `http(s)` URL (pasted link) or
 * an uploaded file, encoded as `upload:<storage-path>`. Uploaded paths are
 * always relative to the private `challenge-uploads` bucket; the admin review
 * page mints a signed URL for them. `file` answers carry their path directly
 * in an UploadedFile object instead.
 */
export const CHALLENGE_UPLOAD_PREFIX = "upload:";
export const CHALLENGE_UPLOAD_BUCKET = "challenge-uploads";
/** Public bucket for staff-uploaded covers and prize photos. */
export const CHALLENGE_MEDIA_BUCKET = "challenge-media";

/**
 * Reserved answer key for the standalone "Demo video" field that pre-0087
 * forms offered on every challenge. No longer rendered, but old submissions
 * still carry it (mirrored into questions_snapshot), so the key stays known.
 */
export const CHALLENGE_EXTRA_VIDEO_KEY = "__demo_video__";

/** Video uploads: short demos from a phone or a screen recorder. */
export const VIDEO_EXTENSIONS = ["mp4", "mov", "webm", "m4v"];
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "heic"];
const DOCUMENT_EXTENSIONS = [...IMAGE_EXTENSIONS, "pdf"];
const ANY_EXTENSIONS = [
  ...DOCUMENT_EXTENSIONS,
  "zip",
  "pptx",
  "key",
  "docx",
  "txt",
  "md",
  "csv",
  "xlsx",
  "mp4",
  "mov",
  "stl",
  "step",
  "f3d",
];

/** Allowed extensions for a file question (lowercase, no dot). */
export function extensionsFor(kind: FileKind): string[] {
  if (kind === "image") return IMAGE_EXTENSIONS;
  if (kind === "document") return DOCUMENT_EXTENSIONS;
  return ANY_EXTENSIONS;
}

/** `accept` attribute value for an <input type=file>. */
export function acceptFor(kind: FileKind): string {
  return extensionsFor(kind)
    .map((e) => `.${e}`)
    .join(",");
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImageFile(f: { name: string; type?: string }): boolean {
  return (
    (f.type ?? "").startsWith("image/") ||
    ["png", "jpg", "jpeg", "webp", "gif"].includes(fileExtension(f.name))
  );
}

/** True when a `video` answer points at an uploaded file rather than a link. */
export function isUploadAnswer(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(CHALLENGE_UPLOAD_PREFIX);
}

/** The storage path inside `challenge-uploads`, or "" for a non-upload value. */
export function uploadPathOf(value: unknown): string {
  return isUploadAnswer(value)
    ? (value as string).slice(CHALLENGE_UPLOAD_PREFIX.length)
    : "";
}

export function isQuestionType(v: unknown): v is ChallengeQuestionType {
  return (
    typeof v === "string" &&
    (CHALLENGE_QUESTION_TYPES as readonly string[]).includes(v)
  );
}

/** Question types that collect no answer. */
export function isInputQuestion(q: Pick<ChallengeQuestion, "type">): boolean {
  return q.type !== "section";
}

function str(v: unknown, max = 10000): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function newId(prefix = ""): string {
  try {
    return prefix + crypto.randomUUID().slice(0, 12);
  } catch {
    return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}

/** Generate a stable id for a new question. Safe in the browser and Node. */
export function newQuestionId(): string {
  return newId();
}

/** Generate a stable id for a prize / schedule / faq / resource row. */
export function newItemId(): string {
  return newId();
}

/** A question with every field at its neutral default. */
export function blankQuestion(
  patch: Partial<ChallengeQuestion> = {},
): ChallengeQuestion {
  return {
    id: newQuestionId(),
    type: "short_text",
    label: "",
    help: "",
    placeholder: "",
    required: false,
    options: [],
    maxLength: null,
    fileKind: "image",
    maxFiles: 3,
    scaleMax: 5,
    scaleMinLabel: "",
    scaleMaxLabel: "",
    maxTeam: 3,
    ...patch,
  };
}

/**
 * Coerce an arbitrary jsonb value into a clean ChallengeQuestion[]. Drops
 * malformed entries, caps counts, and (for choice questions) drops empty
 * options. Used on every read so a bad `questions` blob can't break a page.
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

    const label = str(rec.label, 500).trim();
    if (!label) continue; // a question needs a prompt

    let options: string[] = [];
    if (rec.type === "select" || rec.type === "multi_select") {
      const rawOpts = Array.isArray(rec.options) ? rec.options : [];
      options = Array.from(
        new Set(
          rawOpts
            .filter((o): o is string => typeof o === "string")
            .map((o) => o.trim().slice(0, 200))
            .filter((o) => o.length > 0),
        ),
      ).slice(0, MAX_OPTIONS);
      if (options.length === 0) continue; // a choice needs choices
    }

    const typeMax = rec.type === "long_text" ? LONG_TEXT_MAX : SHORT_TEXT_MAX;
    const maxLength =
      rec.maxLength == null || rec.maxLength === ""
        ? null
        : clampInt(rec.maxLength, 1, typeMax, typeMax);

    const fileKind: FileKind =
      rec.fileKind === "document" || rec.fileKind === "any"
        ? rec.fileKind
        : "image";

    out.push({
      id,
      type: rec.type,
      label,
      help: str(rec.help, 2000),
      placeholder: str(rec.placeholder, 300),
      required: rec.type === "section" ? false : rec.required === true,
      options,
      maxLength,
      fileKind,
      maxFiles: clampInt(rec.maxFiles, 1, MAX_FILES_PER_QUESTION, 3),
      scaleMax: clampInt(rec.scaleMax, 3, 10, 5),
      scaleMinLabel: str(rec.scaleMinLabel, 60),
      scaleMaxLabel: str(rec.scaleMaxLabel, 60),
      maxTeam: clampInt(rec.maxTeam, 1, MAX_TEAM, 3),
    });
  }
  return out;
}

export function sanitizePrizes(raw: unknown): ChallengePrize[] {
  if (!Array.isArray(raw)) return [];
  const out: ChallengePrize[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_PRIZES) break;
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const kind: PrizeKind =
      r.kind === "cash" || r.kind === "perk" ? r.kind : "item";
    const valueCents =
      r.valueCents == null || r.valueCents === ""
        ? null
        : clampInt(r.valueCents, 0, 100_000_000, 0);
    const title = str(r.title, 200).trim();
    // A cash prize can be just an amount; anything else needs a name.
    if (!title && !(kind === "cash" && valueCents != null)) continue;
    let id = str(r.id, 64).trim() || newItemId();
    if (seen.has(id)) id = newItemId();
    seen.add(id);
    const imageUrl = str(r.imageUrl, 1000).trim();
    out.push({
      id,
      place: str(r.place, 80).trim(),
      kind,
      title,
      description: str(r.description, 1000),
      valueCents,
      quantity: clampInt(r.quantity, 1, 1000, 1),
      imageUrl: HTTP_URL_RE.test(imageUrl) ? imageUrl : null,
    });
  }
  return out;
}

export function sanitizeSchedule(raw: unknown): ScheduleItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduleItem[] = [];
  for (const item of raw) {
    if (out.length >= MAX_SCHEDULE) break;
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const at = str(r.at, 64);
    const label = str(r.label, 200).trim();
    if (!label || !at || Number.isNaN(new Date(at).getTime())) continue;
    const url = str(r.url, URL_MAX).trim();
    out.push({
      id: str(r.id, 64) || newItemId(),
      at: new Date(at).toISOString(),
      label,
      detail: str(r.detail, 1000),
      url: HTTP_URL_RE.test(url) ? url : "",
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function sanitizeFaq(raw: unknown): FaqItem[] {
  if (!Array.isArray(raw)) return [];
  const out: FaqItem[] = [];
  for (const item of raw) {
    if (out.length >= MAX_FAQ) break;
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const q = str(r.q, 300).trim();
    const a = str(r.a, 3000).trim();
    if (!q || !a) continue;
    out.push({ id: str(r.id, 64) || newItemId(), q, a });
  }
  return out;
}

export function sanitizeResources(raw: unknown): ResourceLink[] {
  if (!Array.isArray(raw)) return [];
  const out: ResourceLink[] = [];
  for (const item of raw) {
    if (out.length >= MAX_RESOURCES) break;
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const label = str(r.label, 200).trim();
    const url = str(r.url, URL_MAX).trim();
    if (!label || !HTTP_URL_RE.test(url)) continue;
    out.push({
      id: str(r.id, 64) || newItemId(),
      label,
      url,
      description: str(r.description, 500),
    });
  }
  return out;
}

function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function rowToChallenge(row: any): Challenge {
  const kind: ChallengeKind = (CHALLENGE_KINDS as readonly string[]).includes(
    row.kind,
  )
    ? row.kind
    : "challenge";
  const coverTheme: CoverTheme = (COVER_THEMES as readonly string[]).includes(
    row.cover_theme,
  )
    ? row.cover_theme
    : "phosphor";
  return {
    id: row.id,
    slug: row.slug,
    kind,
    title: row.title,
    tagline: typeof row.tagline === "string" ? row.tagline : "",
    description: typeof row.description === "string" ? row.description : "",
    coverImageUrl:
      typeof row.cover_image_url === "string" && row.cover_image_url
        ? row.cover_image_url
        : null,
    coverTheme,
    location:
      typeof row.location === "string" && row.location.trim()
        ? row.location
        : "Online",
    locationUrl:
      typeof row.location_url === "string" && row.location_url
        ? row.location_url
        : null,
    prizeLabel: typeof row.prize_label === "string" ? row.prize_label : "",
    prizeAmountCents:
      typeof row.prize_amount_cents === "number"
        ? row.prize_amount_cents
        : null,
    prizes: sanitizePrizes(row.prizes),
    marqueeText: typeof row.marquee_text === "string" ? row.marquee_text : "",
    ctaLabel:
      typeof row.cta_label === "string" && row.cta_label.trim()
        ? row.cta_label
        : "Register",
    ctaHref:
      typeof row.cta_href === "string" && row.cta_href ? row.cta_href : null,
    status: (row.status as ChallengeStatus) ?? "draft",
    opensAt: isoOrNull(row.opens_at),
    closesAt: isoOrNull(row.closes_at),
    resultsAt: isoOrNull(row.results_at),
    schedule: sanitizeSchedule(row.schedule),
    rules: typeof row.rules === "string" ? row.rules : "",
    faq: sanitizeFaq(row.faq),
    resources: sanitizeResources(row.resources),
    questions: sanitizeQuestions(row.questions),
    referralsRequired:
      typeof row.referrals_required === "number"
        ? Math.max(0, row.referrals_required)
        : 0,
    allowEdits: row.allow_edits !== false,
    featured: row.featured === true,
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
    submittedAt: row.submitted_at ?? null,
    payoutAmountCents:
      typeof row.payout_amount_cents === "number"
        ? row.payout_amount_cents
        : null,
    prizeId: row.prize_id ?? null,
    awardLabel: row.award_label ?? null,
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

// --- Time & phase ----------------------------------------------------------

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Where "now" sits in a challenge's submission window.
 *
 * `upcoming` is the case a plain open/closed boolean gets wrong: an active
 * challenge whose `opensAt` is still ahead isn't open, but it hasn't wrapped
 * up either — telling visitors it was over is what #317 fixed. Registration
 * and drafting are allowed while `upcoming` (see canRegister); only the final
 * submit waits for `open`.
 */
export type ChallengeWindowState = "upcoming" | "open" | "closed";

export function challengeWindowState(
  challenge: Pick<Challenge, "status" | "opensAt" | "closesAt">,
  now = Date.now(),
): ChallengeWindowState {
  // draft / closed / archived all read as closed publicly.
  if (challenge.status !== "active") return "closed";
  const opens = ms(challenge.opensAt);
  const closes = ms(challenge.closesAt);
  if (opens != null && opens > now) return "upcoming";
  if (closes != null && closes < now) return "closed";
  return "open";
}

/** Submissions are open right now. */
export function isChallengeOpen(
  challenge: Pick<Challenge, "status" | "opensAt" | "closesAt">,
  now = Date.now(),
): boolean {
  return challengeWindowState(challenge, now) === "open";
}

/** Registration is open: published and the deadline hasn't passed. Opens
 *  before submissions do, so people can sign up for an upcoming hackathon. */
export function canRegister(
  challenge: Pick<Challenge, "status" | "closesAt">,
  now = Date.now(),
): boolean {
  if (challenge.status !== "active") return false;
  const closes = ms(challenge.closesAt);
  return closes == null || closes > now;
}

export type ChallengePhase =
  | "draft"
  | "upcoming"
  | "live"
  | "judging"
  | "ended"
  | "archived";

/** Where a challenge is in its life, for pills and copy. */
export function challengePhase(
  c: Pick<Challenge, "status" | "opensAt" | "closesAt" | "resultsAt" | "winnersPublished">,
  now = Date.now(),
): ChallengePhase {
  if (c.status === "draft") return "draft";
  if (c.status === "archived") return "archived";
  const opens = ms(c.opensAt);
  const closes = ms(c.closesAt);
  const results = ms(c.resultsAt);
  if (c.status === "active") {
    if (opens != null && opens > now) return "upcoming";
    if (closes == null || closes > now) return "live";
  }
  // Closed, or active past its deadline. "Judging" until winners are out:
  // either the announced results date is still ahead, or the admin hasn't
  // closed it yet (still `active`, deadline passed).
  if (c.winnersPublished) return "ended";
  if (results != null) return results > now ? "judging" : "ended";
  return c.status === "active" ? "judging" : "ended";
}

export const PHASE_LABELS: Record<ChallengePhase, string> = {
  draft: "Draft",
  upcoming: "Upcoming",
  live: "Live",
  judging: "Judging",
  ended: "Ended",
  archived: "Archived",
};

/** The date a challenge is "on" for listings: opens, else closes, else created. */
export function challengeAnchorDate(c: Pick<Challenge, "opensAt" | "closesAt" | "createdAt">): string {
  return c.opensAt ?? c.closesAt ?? c.createdAt;
}

/** "2d 4h", "3h 12m", "12m", "<1m" — compact remaining time. */
export function formatRemaining(msLeft: number): string {
  if (msLeft <= 0) return "0m";
  const m = Math.floor(msLeft / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  if (mm > 0) return `${mm}m`;
  return "<1m";
}

// --- Money & prizes --------------------------------------------------------

/** "$500" from cents, or "" when null. Shared by admin + public surfaces. */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  const dollars = cents / 100;
  return dollars % 1 === 0
    ? `$${dollars.toLocaleString("en-US")}`
    : `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The name a prize shows: its title, or the cash amount when untitled. */
export function prizeTitle(p: ChallengePrize): string {
  if (p.title) return p.title;
  if (p.kind === "cash" && p.valueCents != null) return formatCents(p.valueCents);
  return "Prize";
}

/** Total cash on offer across prizes (quantity-weighted). */
export function totalCashCents(prizes: ChallengePrize[]): number {
  return prizes
    .filter((p) => p.kind === "cash" && p.valueCents != null)
    .reduce((sum, p) => sum + (p.valueCents ?? 0) * p.quantity, 0);
}

/**
 * The one-line prize summary: the admin's own label when set, otherwise built
 * from the prize list — "$750 + Ray-Ban Meta glasses", "Ray-Ban Meta glasses",
 * "$500 in prizes".
 */
export function prizeHeadline(
  c: Pick<Challenge, "prizeLabel" | "prizes">,
): string {
  if (c.prizeLabel.trim()) return c.prizeLabel.trim();
  const cash = totalCashCents(c.prizes);
  const items = c.prizes
    .filter((p) => p.kind === "item" && p.title)
    .map((p) => p.title);
  const uniqueItems = Array.from(new Set(items));
  const parts: string[] = [];
  if (cash > 0) {
    parts.push(
      uniqueItems.length === 0 && c.prizes.length > 1
        ? `${formatCents(cash)} in prizes`
        : formatCents(cash),
    );
  }
  if (uniqueItems.length === 1) parts.push(uniqueItems[0]);
  else if (uniqueItems.length > 1)
    parts.push(`${uniqueItems[0]} & more`);
  if (parts.length === 0 && c.prizes.length > 0) return prizeTitle(c.prizes[0]);
  return parts.join(" + ");
}

/** "1st place — Ray-Ban Meta glasses" for an awarded prize. */
export function awardLabelFor(p: ChallengePrize): string {
  const t = prizeTitle(p);
  return p.place ? `${p.place} — ${t}` : t;
}

// --- Answers ---------------------------------------------------------------

/** True when an answer counts as blank for a "required" check. */
export function answerIsEmpty(
  q: Pick<ChallengeQuestion, "type">,
  v: ChallengeAnswerValue | undefined,
): boolean {
  if (v == null) return true;
  if (q.type === "checkbox") return v !== true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "number") return !Number.isFinite(v);
  if (Array.isArray(v)) {
    if (q.type === "team") {
      return !(v as TeamMember[]).some((m) => m && (m.name ?? "").trim());
    }
    return v.length === 0;
  }
  return false;
}

/** Required-question progress for the form's progress bar. */
export function requiredProgress(
  questions: ChallengeQuestion[],
  answers: ChallengeAnswers,
): { done: number; total: number } {
  const req = questions.filter((q) => q.required && isInputQuestion(q));
  return {
    done: req.filter((q) => !answerIsEmpty(q, answers[q.id])).length,
    total: req.length,
  };
}

function cleanFiles(v: unknown, max: number): UploadedFile[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({
      path: str(f.path, 500),
      name: str(f.name, 200),
      size: clampInt(f.size, 0, 1e10, 0),
      type: str(f.type, 120),
    }))
    .filter((f) => f.path && f.name)
    .slice(0, max);
}

function cleanTeam(v: unknown, max: number): TeamMember[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({
      name: str(m.name, 120).trim(),
      email: str(m.email, 200).trim(),
    }))
    .filter((m) => m.name || m.email)
    .slice(0, max);
}

export type ValidationResult = {
  answers: ChallengeAnswers;
  errors: Record<string, string>;
};

/**
 * Normalise raw answers to the question schema and (in `submit` mode) enforce
 * required + format rules. The ONE validator: the browser runs it for instant
 * feedback, the server runs it again on save and submit, so the two can never
 * disagree about what's valid.
 *
 * `draft` mode keeps whatever fits the shape and reports no errors — a draft is
 * allowed to be half-finished — but still drops anything malformed or oversize.
 * `uploadPrefix` restricts file paths to the entrant's own upload folder so a
 * tampered client can't attach someone else's file.
 */
export function validateAnswers(
  questions: ChallengeQuestion[],
  raw: Record<string, unknown>,
  opts: { mode: "draft" | "submit"; uploadPrefix?: string },
): ValidationResult {
  const answers: ChallengeAnswers = {};
  const errors: Record<string, string> = {};
  const submit = opts.mode === "submit";
  const ownsPath = (p: string) =>
    !opts.uploadPrefix || p.startsWith(opts.uploadPrefix);

  for (const q of questions) {
    if (!isInputQuestion(q)) continue;
    const v = raw?.[q.id];
    let value: ChallengeAnswerValue | undefined;
    let err = "";

    switch (q.type) {
      case "short_text":
      case "long_text": {
        const cap =
          q.maxLength ?? (q.type === "long_text" ? LONG_TEXT_MAX : SHORT_TEXT_MAX);
        const s = typeof v === "string" ? v : "";
        if (s.length > cap) {
          err = `Keep it under ${cap.toLocaleString("en-US")} characters`;
          value = s.slice(0, cap);
        } else value = s;
        break;
      }
      case "url": {
        const s = (typeof v === "string" ? v : "").trim().slice(0, URL_MAX);
        value = s;
        if (s && !HTTP_URL_RE.test(s) && !isUploadAnswer(s)) {
          err = "Paste a full link starting with https://";
        }
        break;
      }
      case "video": {
        const s = (typeof v === "string" ? v : "").trim().slice(0, URL_MAX);
        value = s;
        if (s && isUploadAnswer(s) && !ownsPath(uploadPathOf(s))) {
          value = "";
        } else if (s && !HTTP_URL_RE.test(s) && !isUploadAnswer(s)) {
          err = "Paste a full link starting with https://, or upload a video";
        }
        break;
      }
      case "select": {
        const s = typeof v === "string" ? v : "";
        value = q.options.includes(s) ? s : "";
        break;
      }
      case "multi_select": {
        const arr = Array.isArray(v) ? v : [];
        value = q.options.filter((o) => arr.includes(o));
        break;
      }
      case "number": {
        const n =
          typeof v === "number"
            ? v
            : typeof v === "string" && v.trim() !== ""
              ? Number(v)
              : NaN;
        if (Number.isFinite(n)) value = n;
        else if (typeof v === "string" && v.trim() !== "") {
          err = "Enter a number";
        }
        break;
      }
      case "scale": {
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isInteger(n) && n >= 1 && n <= q.scaleMax) value = n;
        break;
      }
      case "checkbox": {
        value = v === true;
        break;
      }
      case "file": {
        const files = cleanFiles(v, q.maxFiles).filter((f) => ownsPath(f.path));
        value = files;
        if (Array.isArray(v) && v.length > q.maxFiles) {
          err = `Up to ${q.maxFiles} file${q.maxFiles === 1 ? "" : "s"}`;
        }
        break;
      }
      case "team": {
        const team = cleanTeam(v, q.maxTeam);
        value = team;
        if (submit) {
          const bad = team.find((m) => m.email && !EMAIL_RE.test(m.email));
          const nameless = team.find((m) => !m.name);
          if (bad) err = `"${bad.email}" isn't a valid email`;
          else if (nameless) err = "Every teammate needs a name";
        }
        break;
      }
    }

    if (value !== undefined) answers[q.id] = value;
    if (submit) {
      if (!err && q.required && answerIsEmpty(q, value)) {
        err = q.type === "checkbox" ? "Please confirm to continue" : "Required";
      }
      if (err) errors[q.id] = err;
    }
  }
  return { answers, errors };
}

// --- Quick-add presets for the admin form builder --------------------------

export type QuestionPreset = {
  key: string;
  label: string;
  make: () => ChallengeQuestion;
};

export const QUESTION_PRESETS: QuestionPreset[] = [
  {
    key: "project_name",
    label: "Project name",
    make: () =>
      blankQuestion({
        type: "short_text",
        label: "Project name",
        placeholder: "e.g. StudyBuddy",
        required: true,
        maxLength: 80,
      }),
  },
  {
    key: "pitch",
    label: "One-line pitch",
    make: () =>
      blankQuestion({
        type: "short_text",
        label: "One-line pitch",
        help: "What does it do, in one sentence?",
        placeholder: "An AI tutor that quizzes you on your own notes",
        required: true,
        maxLength: 140,
      }),
  },
  {
    key: "description",
    label: "Description",
    make: () =>
      blankQuestion({
        type: "long_text",
        label: "Tell us about it",
        help: "What problem does it solve, who's it for, and how did you build it?",
        required: true,
        maxLength: 2000,
      }),
  },
  {
    key: "demo_link",
    label: "Demo link",
    make: () =>
      blankQuestion({
        type: "url",
        label: "Live demo link",
        placeholder: "https://…",
      }),
  },
  {
    key: "repo",
    label: "Source code",
    make: () =>
      blankQuestion({
        type: "url",
        label: "Source code",
        help: "GitHub, Replit, or wherever the code lives.",
        placeholder: "https://github.com/…",
      }),
  },
  {
    key: "video",
    label: "Demo video",
    make: () =>
      blankQuestion({
        type: "video",
        label: "Demo video",
        help: "A 1–3 minute walkthrough. Paste a Loom/YouTube link or upload a video from your phone.",
        placeholder: "https://www.loom.com/share/…",
      }),
  },
  {
    key: "screenshots",
    label: "Screenshots",
    make: () =>
      blankQuestion({
        type: "file",
        label: "Screenshots",
        fileKind: "image",
        maxFiles: 5,
      }),
  },
  {
    key: "deck",
    label: "Pitch deck",
    make: () =>
      blankQuestion({
        type: "file",
        label: "Pitch deck",
        help: "PDF works best.",
        fileKind: "document",
        maxFiles: 1,
      }),
  },
  {
    key: "team",
    label: "Team members",
    make: () =>
      blankQuestion({
        type: "team",
        label: "Who built it with you?",
        help: "Leave empty if you built it solo.",
        maxTeam: 3,
      }),
  },
  {
    key: "built_with",
    label: "Built with",
    make: () =>
      blankQuestion({
        type: "multi_select",
        label: "What did you build it with?",
        options: [
          "Python",
          "JavaScript / TypeScript",
          "AI APIs (OpenAI, Claude, …)",
          "No-code tools",
          "Hardware / Arduino",
          "Other",
        ],
      }),
  },
  {
    key: "grade",
    label: "Grade",
    make: () =>
      blankQuestion({
        type: "select",
        label: "What grade are you in?",
        options: ["8th or below", "9th", "10th", "11th", "12th", "Gap year / other"],
      }),
  },
  {
    key: "rules",
    label: "Agree to rules",
    make: () =>
      blankQuestion({
        type: "checkbox",
        label: "I built this myself (or with my listed team) and agree to the rules",
        required: true,
      }),
  },
  {
    key: "section",
    label: "Section heading",
    make: () =>
      blankQuestion({
        type: "section",
        label: "About your project",
      }),
  },
];

// --- Referrals -------------------------------------------------------------

export type ReferralSource = "registered" | "applied";

export type QualifiedReferral = {
  userId: string;
  source: ReferralSource;
  at: string;
};

/**
 * Merge the two ways a referred friend can qualify — registering for this
 * challenge, or submitting a cohort application — into one deduped list.
 *
 * A friend counts ONCE no matter how many qualifying things they did, never
 * counts toward their own referrer total (self-referral), and must have acted
 * on or after `since` (the challenge's creation), so referrals from before the
 * challenge existed don't pre-satisfy its requirement. Earliest action wins, so
 * the "how" shown next to their name is what they did first.
 */
export function mergeQualifiedReferrals(
  input: {
    registrations: Array<{ user_id: string; created_at: string }>;
    applications: Array<{ user_id: string; submitted_at: string | null }>;
  },
  opts: { referrerId: string; since: string },
): QualifiedReferral[] {
  const since = new Date(opts.since).getTime();
  const best = new Map<string, QualifiedReferral>();
  const consider = (userId: string, at: string | null, source: ReferralSource) => {
    if (!userId || !at || userId === opts.referrerId) return;
    const t = new Date(at).getTime();
    if (Number.isNaN(t) || t < since) return;
    const prev = best.get(userId);
    if (!prev || t < new Date(prev.at).getTime()) {
      best.set(userId, { userId, source, at });
    }
  };
  for (const r of input.registrations) consider(r.user_id, r.created_at, "registered");
  for (const a of input.applications) consider(a.user_id, a.submitted_at, "applied");
  return Array.from(best.values()).sort((a, b) => a.at.localeCompare(b.at));
}

/** "Maya R." — first name + last initial, for showing referred friends. */
export function shortName(full: string | null | undefined): string {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A friend";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** The share link that attributes sign-ups to `code`. */
export function challengeReferralLink(
  siteUrl: string,
  slug: string,
  code: string,
): string {
  return `${siteUrl.replace(/\/$/, "")}/challenges/${slug}?ref=${encodeURIComponent(code)}`;
}

// --- Calendar --------------------------------------------------------------

function gcalDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, "");
}

/** Google Calendar "add event" URL spanning opens → closes. */
export function googleCalendarUrl(
  c: Pick<Challenge, "title" | "tagline" | "opensAt" | "closesAt" | "location">,
  pageUrl: string,
): string | null {
  const end = c.closesAt ?? c.opensAt;
  if (!end) return null;
  const start = c.opensAt ?? new Date(new Date(end).getTime() - 3600_000).toISOString();
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: c.title,
    dates: `${gcalDate(start)}/${gcalDate(end)}`,
    details: `${c.tagline ? c.tagline + "\n\n" : ""}${pageUrl}`,
    location: c.location || "Online",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
