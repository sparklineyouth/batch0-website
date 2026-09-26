// ---------------------------------------------------------------------------
// The /apply flow as data: which screens an applicant sees, in what order, and
// what each one needs before they can move on.
//
// /apply asks one question per screen. That makes "which questions exist" and
// "what does this answer need" decisions that three places have to agree on:
// the screen list the form walks, the per-screen check that gates Continue, and
// the whole-form check that runs before submit (and that the server action
// mirrors). Keeping them here, as pure functions over plain data, is what lets
// lib/apply-flow.test.ts pin them down — the old four-step wizard kept its
// rules inside the component, where the one that mattered most (an admin
// marking a field required) had quietly stopped being enforced at all.
//
// IMPORT-FREE apart from sibling pure modules, for the same reason as
// lib/question-schema.ts: `npm test` loads this under Node's type stripping,
// which cannot resolve `@/` aliases or load a Supabase client.
// ---------------------------------------------------------------------------

import {
  QUESTION_FIELD_MAP,
  QUESTION_FIELDS,
  isRequiredCore,
  type MergedQuestion,
} from "./application-fields.ts";
import {
  checkAnswers,
  fieldName,
  readAnswers,
  type CustomQuestion,
} from "./question-schema.ts";
import { isValidPhone, PHONE_MAX_LENGTH } from "./phone.ts";

/** The 17 column-backed answers, as the form holds them: every value a string. */
export type FormState = {
  full_name: string;
  age: string;
  grade: string;
  school: string;
  city: string;
  country: string;
  phone: string;
  parent_email: string;
  why_join: string;
  startup_idea: string;
  experience: string;
  hours_per_week: string;
  team_size: string;
  referral_source: string;
  linkedin_url: string;
  resume_url: string;
  portfolio_url: string;
};

export type FormKey = keyof FormState;

/** Admin-authored answers, keyed by POSTED field name (prefix__id). */
export type AnswerState = Record<string, string>;

export type QuestionMap = Record<string, MergedQuestion>;

/** Restore a saved choice without overriding the intake the student just
 * explicitly opened. Answer recovery must not change that current intent. */
export function restoreDraftCohort(
  currentId: string | null,
  explicitId: string | null,
  backupId: string | null,
  allowedIds: string[],
): string | null {
  if (explicitId && allowedIds.includes(explicitId)) return explicitId;
  if (backupId) return allowedIds.includes(backupId) ? backupId : null;
  return currentId;
}

/**
 * Per-field length ceilings. The same numbers as the server's SubmitSchema in
 * app/apply/actions.ts — the inputs carry them as maxLength so an answer can't
 * be typed past what the server will accept.
 */
export const MAX_LENGTH: Record<FormKey, number> = {
  full_name: 120,
  age: 3,
  grade: 40,
  school: 160,
  city: 120,
  country: 120,
  phone: PHONE_MAX_LENGTH,
  parent_email: 160,
  why_join: 2000,
  startup_idea: 2000,
  experience: 2000,
  hours_per_week: 3,
  team_size: 1,
  referral_source: 200,
  linkedin_url: 500,
  resume_url: 500,
  portfolio_url: 500,
};

/** The why_join floor. SubmitSchema's `.min(40)`. */
export const WHY_MIN = 40;

export const URL_RE = /^https?:\/\/.+/;
export const EMAIL_RE = /^\S+@\S+\.\S+$/;

export const LINK_KEYS = ["linkedin_url", "resume_url", "portfolio_url"] as const;
export const LOCATION_KEYS = ["city", "country"] as const;

/** Every built-in key, in skeleton order — what a submit posts. */
export const FORM_KEYS = QUESTION_FIELDS.map((f) => f.key) as FormKey[];

export function emptyForm(): FormState {
  const out = {} as FormState;
  for (const key of FORM_KEYS) out[key] = "";
  return out;
}

/**
 * The resolved question config, keyed by field. Seeded from the code defaults
 * so a missing or partial prop can never leave a field undefined.
 */
export function buildQuestionMap(questions: readonly MergedQuestion[] | undefined): QuestionMap {
  const map: QuestionMap = {};
  for (const f of QUESTION_FIELDS) map[f.key] = { ...f };
  for (const q of questions ?? []) map[q.key] = q;
  return map;
}

/** Whether a field is on the form. The server-required cores always are. */
export function isVisible(cfg: QuestionMap, key: string): boolean {
  if (isRequiredCore(key)) return true;
  return !cfg[key]?.hidden;
}

/** Whether the config requires a field. The cores always are. */
export function isRequired(cfg: QuestionMap, key: string): boolean {
  if (isRequiredCore(key)) return true;
  return !!cfg[key]?.required;
}

export function parseAge(age: string): number | null {
  const n = Number.parseInt(age, 10);
  return Number.isNaN(n) ? null : n;
}

export function isMinor(age: string): boolean {
  const n = parseAge(age);
  return n !== null && n < 18;
}

/**
 * Whether the parent/guardian email is asked at all.
 *
 * Asked of every applicant under 18 — even if an admin removed the field —
 * because SubmitSchema requires it for minors and the Terms promise parental
 * consent; hiding it would only produce a submit the server rejects over a
 * question the applicant was never shown. Asked of adults only when an admin
 * has made it required; otherwise it's noise ("only needed if you're under 18").
 */
export function asksParentEmail(cfg: QuestionMap, form: Pick<FormState, "age">): boolean {
  if (isMinor(form.age)) return true;
  return isVisible(cfg, "parent_email") && isRequired(cfg, "parent_email");
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

export type Section = "cohort" | "about" | "idea" | "background" | "more" | "scholarships";

export const SECTION_LABELS: Record<Section, string> = {
  cohort: "Your cohort",
  about: "About you",
  idea: "Your idea",
  background: "Your background",
  more: "A few more",
  scholarships: "Scholarships",
};

export type Screen =
  | { id: "welcome"; kind: "welcome" }
  | { id: "cohort"; kind: "cohort"; section: Section }
  | { id: FormKey; kind: "field"; key: FormKey; section: Section }
  | { id: "location"; kind: "location"; section: Section }
  | { id: "links"; kind: "links"; section: Section }
  | {
      id: string;
      kind: "custom";
      prefix: string;
      question: CustomQuestion;
      section: Section;
      /** First screen of the scholarship block — carries its explainer. */
      intro: boolean;
    }
  | { id: "review"; kind: "review" };

export type QuestionScreen = Exclude<Screen, { kind: "welcome" } | { kind: "review" }>;

export type ScreenArgs = {
  cfg: QuestionMap;
  customQuestions: readonly CustomQuestion[];
  scholarshipQuestions: readonly CustomQuestion[];
  customPrefix: string;
  scholarshipPrefix: string;
  /** More than one cohort is open to this applicant, so they pick one. */
  chooseCohort: boolean;
  form: Pick<FormState, "age">;
};

/**
 * The screens, in order. Depends on the answers so far only through age: the
 * parent/guardian question appears the moment someone says they're under 18.
 *
 * Order: who you are, then the essay while they're still fresh, then the
 * background and logistics, then anything an admin added. Custom questions and
 * the scholarship block come last because, as before, they're their own
 * sections rather than interleaved with the column-backed fields.
 */
export function buildScreens(args: ScreenArgs): Screen[] {
  const { cfg, form } = args;
  const out: Screen[] = [{ id: "welcome", kind: "welcome" }];
  const field = (key: FormKey, section: Section) => {
    if (isVisible(cfg, key)) out.push({ id: key, kind: "field", key, section });
  };

  if (args.chooseCohort) out.push({ id: "cohort", kind: "cohort", section: "cohort" });

  field("full_name", "about");
  field("age", "about");
  if (asksParentEmail(cfg, form)) {
    out.push({ id: "parent_email", kind: "field", key: "parent_email", section: "about" });
  }
  field("phone", "about");
  field("grade", "about");
  field("school", "about");
  if (LOCATION_KEYS.some((k) => isVisible(cfg, k))) {
    out.push({ id: "location", kind: "location", section: "about" });
  }

  field("why_join", "idea");
  field("startup_idea", "idea");
  field("team_size", "idea");

  field("experience", "background");
  field("hours_per_week", "background");
  if (LINK_KEYS.some((k) => isVisible(cfg, k))) {
    out.push({ id: "links", kind: "links", section: "background" });
  }
  field("referral_source", "background");

  for (const question of args.customQuestions) {
    if (question.hidden) continue;
    out.push({
      id: fieldName(args.customPrefix, question.id),
      kind: "custom",
      prefix: args.customPrefix,
      question,
      section: "more",
      intro: false,
    });
  }

  let first = true;
  for (const question of args.scholarshipQuestions) {
    if (question.hidden) continue;
    out.push({
      id: fieldName(args.scholarshipPrefix, question.id),
      kind: "custom",
      prefix: args.scholarshipPrefix,
      question,
      section: "scholarships",
      intro: first,
    });
    first = false;
  }

  out.push({ id: "review", kind: "review" });
  return out;
}

/** The FormData keys a screen owns — used to route a server error to its screen. */
export function screenFieldNames(screen: Screen): string[] {
  switch (screen.kind) {
    case "cohort":
      return ["cohort_id"];
    case "field":
      return [screen.key];
    case "location":
      return [...LOCATION_KEYS];
    case "links":
      return [...LINK_KEYS];
    case "custom":
      return [screen.id];
    default:
      return [];
  }
}

/** Index of the screen that owns a posted field name, or -1. */
export function screenIndexForField(screens: readonly Screen[], name: string): number {
  return screens.findIndex((s) => screenFieldNames(s).includes(name));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationContext = {
  form: FormState;
  cfg: QuestionMap;
  extra: AnswerState;
  cohortId: string | null;
  /** Ids of the cohorts this applicant may pick. */
  cohortIds: readonly string[];
};

const REQUIRED = "Please fill this in.";

function blank(v: string | undefined): boolean {
  return !v || v.trim().length === 0;
}

/**
 * The rules for one built-in field, including "required". Returns the error
 * message or null. `parent_email` needs the whole form (its requirement hangs
 * off age), so it gets the form rather than just its own value.
 */
export function fieldError(key: FormKey, form: FormState, cfg: QuestionMap): string | null {
  const value = form[key] ?? "";
  const trimmed = value.trim();
  if (trimmed.length > MAX_LENGTH[key]) {
    return `Keep this under ${MAX_LENGTH[key]} characters.`;
  }

  switch (key) {
    case "age": {
      if (blank(value)) return REQUIRED;
      const n = parseAge(value);
      if (n === null || !/^\d+$/.test(trimmed) || n < 10 || n > 25) {
        return "Enter your age as a number between 10 and 25.";
      }
      return null;
    }
    case "phone":
      if (blank(value)) return REQUIRED;
      return isValidPhone(value) ? null : "That doesn't look like a phone number — include your area code.";
    case "parent_email": {
      const required = isMinor(form.age) || (isVisible(cfg, key) && isRequired(cfg, key));
      if (blank(value)) {
        if (!required) return null;
        return isMinor(form.age) ? "We need this because you're under 18." : REQUIRED;
      }
      return EMAIL_RE.test(trimmed) ? null : "That doesn't look like an email address.";
    }
    case "why_join": {
      const len = trimmed.length;
      if (len === 0) return REQUIRED;
      if (len < WHY_MIN) {
        return `A little more, please — at least ${WHY_MIN} characters (you're at ${len}).`;
      }
      return null;
    }
    case "team_size": {
      const n = Number.parseInt(trimmed, 10);
      return /^\d$/.test(trimmed) && n >= 1 && n <= 5 ? null : "Pick one to continue.";
    }
    case "hours_per_week": {
      if (blank(value)) return isVisible(cfg, key) && isRequired(cfg, key) ? REQUIRED : null;
      const n = Number(trimmed);
      return /^\d+$/.test(trimmed) && n >= 0 && n <= 168
        ? null
        : "Enter a whole number of hours, 0–168.";
    }
    case "linkedin_url":
    case "resume_url":
    case "portfolio_url":
      if (blank(value)) return isVisible(cfg, key) && isRequired(cfg, key) ? REQUIRED : null;
      return URL_RE.test(trimmed) ? null : "Links need to start with https://";
    default:
      if (blank(value)) return isVisible(cfg, key) && isRequired(cfg, key) ? REQUIRED : null;
      return null;
  }
}

/** Errors for one screen, keyed by posted field name. Empty = good to go. */
export function validateScreen(screen: Screen, ctx: ValidationContext): Record<string, string> {
  const errs: Record<string, string> = {};
  const check = (key: FormKey) => {
    const err = fieldError(key, ctx.form, ctx.cfg);
    if (err) errs[key] = err;
  };
  switch (screen.kind) {
    case "cohort":
      if (!ctx.cohortId || !ctx.cohortIds.includes(ctx.cohortId)) {
        errs.cohort_id = "Pick a cohort to continue.";
      }
      break;
    case "field":
      check(screen.key);
      break;
    case "location":
      for (const key of LOCATION_KEYS) if (isVisible(ctx.cfg, key)) check(key);
      break;
    case "links":
      for (const key of LINK_KEYS) if (isVisible(ctx.cfg, key)) check(key);
      break;
    case "custom": {
      const checked = checkAnswers(
        [screen.question],
        readAnswers([screen.question], ctx.extra, screen.prefix),
      );
      if (!checked.ok) {
        for (const msg of Object.values(checked.errors)) errs[screen.id] = msg;
      }
      break;
    }
  }
  return errs;
}

/**
 * Every screen's errors, plus the first screen that has any — where submit
 * sends the applicant back to.
 */
export function validateAll(
  screens: readonly Screen[],
  ctx: ValidationContext,
): { errors: Record<string, string>; firstInvalid: number } {
  const errors: Record<string, string> = {};
  let firstInvalid = -1;
  screens.forEach((screen, i) => {
    const errs = validateScreen(screen, ctx);
    if (Object.keys(errs).length > 0) {
      Object.assign(errors, errs);
      if (firstInvalid === -1) firstInvalid = i;
    }
  });
  return { errors, firstInvalid };
}

/**
 * Server half of "an admin can make a built-in field required".
 *
 * SubmitSchema only knows the five cores (and the under-18 parent email). A
 * field an admin marked required — Country, say — used to get an asterisk and
 * nothing else: the form let it through blank and so did the server. This is
 * the check app/apply/actions.ts runs on submit, over the same config the form
 * validated against. Pass the RAW posted strings, not zod's output: SubmitSchema
 * coerces a blank hours_per_week to 0, which would read as answered.
 */
export function requiredBuiltinErrors(
  cfg: QuestionMap,
  values: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const f of QUESTION_FIELDS) {
    const key = f.key;
    // Minors' parent email is SubmitSchema's own rule; an admin-required one
    // (asked of everyone, see asksParentEmail) is checked here like any other.
    if (isRequiredCore(key)) continue;
    if (!isVisible(cfg, key) || !isRequired(cfg, key)) continue;
    const v = values[key];
    if (v === undefined || v === null || String(v).trim() === "") errs[key] = "Required";
  }
  return errs;
}

/**
 * "github.com/ada" → "https://github.com/ada". What people paste is a bare
 * domain; the rule wants a scheme, so add it rather than scold them. Anything
 * that doesn't look like a domain is left for the validator to flag.
 */
export function withScheme(value: string): string {
  const t = value.trim();
  return t && !/^https?:\/\//i.test(t) && /^[^\s]+\.[^\s]+/.test(t) ? `https://${t}` : value;
}

/**
 * The answers as they should be posted. A parent email the flow isn't asking
 * for — typed while under 18, then the age corrected to 18+ — is on no screen
 * and no review row, so the applicant can neither see nor remove it. Posting it
 * anyway would store an address that parent outreach then emails (or, if it's
 * half-typed, fail every save over a field they can't reach). State keeps the
 * typed value, so it comes back if the age drops under 18 again.
 */
export function postableForm(form: FormState, cfg: QuestionMap): FormState {
  return asksParentEmail(cfg, form) ? form : { ...form, parent_email: "" };
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** Whether a screen has anything typed into it (not whether it's valid). */
export function screenHasAnswer(screen: Screen, ctx: ValidationContext): boolean {
  switch (screen.kind) {
    case "cohort":
      return !!ctx.cohortId;
    case "field":
      return !blank(ctx.form[screen.key]);
    case "location":
      return LOCATION_KEYS.some((k) => !blank(ctx.form[k]));
    case "links":
      return LINK_KEYS.some((k) => !blank(ctx.form[k]));
    case "custom":
      return !blank(ctx.extra[screen.id]);
    default:
      return false;
  }
}

/**
 * Where a returning applicant should land: just past the furthest screen they
 * have answered, but never past a screen that still needs something — so a
 * draft with a gap early on reopens at the gap, not at the end.
 */
export function resumeIndex(screens: readonly Screen[], ctx: ValidationContext): number {
  let lastAnswered = -1;
  screens.forEach((screen, i) => {
    if (screenHasAnswer(screen, ctx)) lastAnswered = i;
  });
  const reviewAt = screens.length - 1;
  if (lastAnswered === -1) return 1 < screens.length ? 1 : 0;
  const { firstInvalid } = validateAll(screens.slice(0, lastAnswered + 1), ctx);
  const target = firstInvalid !== -1 ? firstInvalid : lastAnswered + 1;
  return Math.max(1, Math.min(target, reviewAt));
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** "Ada Lovelace" → "Ada". */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? "";
}

/**
 * The conversational phrasing for a built-in question, used only while the
 * admin hasn't reworded it: an edited label is the admin's words and is shown
 * verbatim. `name` is the applicant's first name, once they've given it.
 */
export function promptFor(key: FormKey, cfg: QuestionMap, name: string): string {
  const label = cfg[key]?.label ?? key;
  if (label !== QUESTION_FIELD_MAP[key]?.label) return label;
  switch (key) {
    case "full_name":
      return "First things first — what's your full name?";
    case "age":
      return name ? `Nice to meet you, ${name}. How old are you?` : "How old are you?";
    case "parent_email":
      return "What's a parent or guardian's email?";
    case "phone":
      return "What's the best number to reach you?";
    case "grade":
      return "What grade are you in?";
    case "school":
      return "Where do you go to school?";
    case "why_join":
      return name ? `Why do you want to join batch0, ${name}?` : "Why do you want to join batch0?";
    case "startup_idea":
      return "Do you have a project idea yet?";
    case "team_size":
      return "How big is your founding team?";
    case "experience":
      return "Tell us about something you've built, led, or worked on.";
    case "hours_per_week":
      return "How many hours a week can you put in?";
    case "referral_source":
      return "How did you hear about batch0?";
    default:
      return label;
  }
}

/** One-tap answers offered under a few free-text questions. The input stays editable. */
export const QUICK_PICKS: Partial<Record<FormKey, readonly string[]>> = {
  grade: ["8th", "9th", "10th", "11th", "12th"],
  hours_per_week: ["5", "10", "15", "20"],
  referral_source: ["Google", "ChatGPT or another AI", "A friend", "TikTok", "Instagram", "My school"],
};

/** A → 0, B → 1 … for the choice-list keyboard shortcuts. */
export function choiceKey(index: number): string {
  return String.fromCharCode(65 + index);
}
