// ---------------------------------------------------------------------------
// Admin-authored questions — the shared type system.
//
// Two different forms are built out of this module:
//
//   1. The extra questions an admin adds to /apply beyond the 17 fixed,
//      column-backed fields (lib/application-questions.ts). Their answers land
//      in `applications.custom_answers`.
//   2. The questions attached to one scholarship (lib/scholarships.ts). Their
//      answers land in `scholarship_applications.answers`.
//
// Both are "a list of questions an admin typed, answered into a jsonb blob",
// so they share one definition, one validator and one renderer. Keeping them
// apart would mean two slightly-different notions of what "required" means,
// and the second one would be the buggy one.
//
// IMPORT-FREE ON PURPOSE. `npm test` runs lib/*.test.ts through Node's native
// type stripping, which cannot resolve `@/` path aliases, and the admin editor
// imports this into a client component. No Supabase, no next/headers, no env.
// Everything here is a pure function over plain data, with one documented
// exception: validateQuestionList fills a blank id in place.
// ---------------------------------------------------------------------------

/**
 * The input types an admin can choose from.
 *
 * Deliberately a short list. Every entry here has to survive being rendered on
 * the public form, validated on the server, displayed in the admin review
 * queue and exported to CSV — so a type earns its place by being worth that
 * cost four times over. File uploads are the notable omission: they need
 * storage, virus scanning and a retention policy, and a `url` question asking
 * for a Drive link covers the real need today.
 */
export type QuestionType =
  | "text"
  | "textarea"
  | "number"
  | "email"
  | "url"
  | "select"
  | "radio"
  | "checkbox"
  | "date";

export const QUESTION_TYPES: readonly QuestionType[] = Object.freeze([
  "text",
  "textarea",
  "number",
  "email",
  "url",
  "select",
  "radio",
  "checkbox",
  "date",
]);

/** Human labels for the type picker in the admin editor. */
export const QUESTION_TYPE_LABELS: Readonly<Record<QuestionType, string>> =
  Object.freeze({
    text: "Short text",
    textarea: "Long text",
    number: "Number",
    email: "Email address",
    url: "Link",
    select: "Dropdown",
    radio: "Multiple choice",
    checkbox: "Checkbox",
    date: "Date",
  });

/** The types that carry a fixed option list. */
export function hasOptions(type: QuestionType): boolean {
  return type === "select" || type === "radio";
}

export type QuestionOption = {
  /** Stored in the answer blob. Stable across label edits. */
  value: string;
  label: string;
};

/**
 * One admin-authored question.
 *
 * `id` is the jsonb key the answer is filed under, so it is effectively
 * permanent: changing it orphans every answer already collected. It is derived
 * from the label while the question is still new and never offered for editing
 * after that, which is why `slugifyQuestionId` below has to produce something
 * readable rather than a uuid — an orphaned answer blob is far easier to read
 * back when its keys say `biggest_risk` instead of `q_7f3a`.
 */
export type CustomQuestion = {
  id: string;
  type: QuestionType;
  label: string;
  help: string;
  placeholder: string;
  required: boolean;
  /** Kept in the config but not rendered. The admin "Remove" action. */
  hidden: boolean;
  /** select/radio only. Empty for every other type. */
  options: QuestionOption[];
};

// Limits. These are the same numbers the server action enforces, exported so
// the editor can show a counter rather than letting someone type 4,000
// characters into a label and only find out on save.
export const LABEL_MAX = 200;
export const HELP_MAX = 600;
export const PLACEHOLDER_MAX = 200;
export const OPTION_LABEL_MAX = 120;
export const QUESTION_ID_MAX = 48;
export const MAX_QUESTIONS = 40;
export const MAX_OPTIONS = 12;

/** Answer-length ceilings, by type. Bounds what a single submit can write. */
export const TEXT_ANSWER_MAX = 500;
export const TEXTAREA_ANSWER_MAX = 5000;

/**
 * Reserved ids. A custom question may not collide with one of the 17
 * column-backed application fields, because both sets are merged into a single
 * ordered list for rendering and a duplicate id would make one of them
 * unreachable — silently dropping either a built-in field or the admin's new
 * question, depending on merge order.
 *
 * Listed as plain strings rather than imported from lib/application-questions
 * to keep this module import-free. lib/application-questions.test.ts asserts
 * the two lists agree, so they cannot drift.
 */
export const RESERVED_QUESTION_IDS: readonly string[] = Object.freeze([
  "full_name",
  "age",
  "grade",
  "school",
  "city",
  "country",
  "phone",
  "parent_email",
  "experience",
  "hours_per_week",
  "referral_source",
  "linkedin_url",
  "resume_url",
  "portfolio_url",
  "why_join",
  "startup_idea",
  "team_size",
  // Not a form field, but written alongside them on the same table.
  "referral_code",
  "cohort_id",
  "id",
  "user_id",
  "status",
]);

// 1–48 characters: a leading letter plus up to QUESTION_ID_MAX-1 more. The
// upper bound matches slugifyQuestionId's truncation, so an id it generates
// always satisfies the pattern that validates it.
export const QUESTION_ID_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * Turn a label into a stable jsonb key.
 *
 * Lowercase, underscore-joined, leading digit prefixed (a key must start with
 * a letter so it can never be mistaken for an array index when the blob is
 * read back through a generic jsonb viewer), truncated to QUESTION_ID_MAX.
 * Returns "" when there is nothing usable, which callers treat as "ask the
 * admin to type an id manually" rather than inventing one.
 */
export function slugifyQuestionId(input: string): string {
  const base = String(input ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip the accents NFKD just split off
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, QUESTION_ID_MAX);
  if (!base) return "";
  return /^[a-z]/.test(base) ? base : `q_${base}`.slice(0, QUESTION_ID_MAX);
}

/**
 * Pick an id for `label` that doesn't collide with anything in `taken`.
 *
 * Appends _2, _3, … rather than a random suffix so that an admin who adds
 * "Why now?" twice gets `why_now` and `why_now_2` — both legible in the
 * export. Gives up after 50 tries and returns "" so the caller surfaces a real
 * error instead of looping.
 */
export function uniqueQuestionId(
  label: string,
  taken: readonly string[],
): string {
  const base = slugifyQuestionId(label);
  if (!base) return "";
  const used = new Set([...taken, ...RESERVED_QUESTION_IDS]);
  if (!used.has(base)) return base;
  for (let n = 2; n <= 50; n += 1) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, QUESTION_ID_MAX - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return "";
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/**
 * Read one string field off a not-yet-parsed entry.
 *
 * Needed by normalizeQuestions below, which has to look at an entry's label
 * before normalizeQuestion has agreed to parse it at all.
 */
function rawString(raw: unknown, key: string): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === "string" ? v.trim() : "";
}

function asQuestionType(v: unknown): QuestionType | null {
  return typeof v === "string" && (QUESTION_TYPES as readonly string[]).includes(v)
    ? (v as QuestionType)
    : null;
}

/**
 * Tolerantly parse one stored question.
 *
 * Returns null for anything unrecognisable rather than throwing. This runs on
 * the read path for /apply and for every scholarship page, so a single corrupt
 * entry — written by an older build, or hand-edited in the SQL console — must
 * cost that one question and nothing else. A form that renders 5 of 6
 * questions is a bug report; a form that 500s is an outage.
 */
export function normalizeQuestion(raw: unknown): CustomQuestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const id = typeof r.id === "string" ? r.id : "";
  if (!QUESTION_ID_PATTERN.test(id)) return null;

  const type = asQuestionType(r.type);
  if (!type) return null;

  const label = str(r.label, LABEL_MAX).trim();
  if (!label) return null;

  let options: QuestionOption[] = [];
  if (hasOptions(type)) {
    const rawOptions = Array.isArray(r.options) ? r.options : [];
    const seen = new Set<string>();
    for (const o of rawOptions) {
      if (!o || typeof o !== "object") continue;
      const oo = o as Record<string, unknown>;
      const value = str(oo.value, OPTION_LABEL_MAX).trim();
      const optLabel = str(oo.label, OPTION_LABEL_MAX).trim();
      if (!value || !optLabel || seen.has(value)) continue;
      seen.add(value);
      options.push({ value, label: optLabel });
      if (options.length >= MAX_OPTIONS) break;
    }
    // A choice question with no surviving options can't be answered at all.
    // Dropping it beats rendering an empty dropdown that blocks submit.
    if (options.length === 0) return null;
  }

  return {
    id,
    type,
    label,
    help: str(r.help, HELP_MAX),
    placeholder: str(r.placeholder, PLACEHOLDER_MAX),
    required: r.required === true,
    hidden: r.hidden === true,
    options,
  };
}

/**
 * Parse a stored question list, dropping anything malformed and any duplicate
 * id. Always returns an array — never throws, for the reason above.
 *
 * An entry whose ONLY problem is a missing id gets one derived from its label
 * instead of being dropped. That is legacy tolerance for rows already in the
 * database, not a save-path safeguard: both save paths now fill a blank id
 * through validateQuestionList before writing, so nothing stores an id-less
 * row any more. The derivation is the same one validateQuestionList applies,
 * so a legacy row still reads under the key it would have been given.
 */
export function normalizeQuestions(raw: unknown): CustomQuestion[] {
  if (!Array.isArray(raw)) return [];
  // Every id claimed anywhere in the list, including entries further down that
  // haven't been parsed yet — a derived id must not steal one of theirs.
  const taken = raw.map((entry) => rawString(entry, "id")).filter(Boolean);
  const out: CustomQuestion[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let q = normalizeQuestion(entry);
    if (!q && !rawString(entry, "id")) {
      const derived = uniqueQuestionId(rawString(entry, "label"), taken);
      // "" is uniqueQuestionId giving up. Leave the entry dropped rather than
      // invent a permanent jsonb key out of a label with nothing in it.
      if (derived) {
        q = normalizeQuestion({ ...(entry as object), id: derived });
        if (q) taken.push(q.id);
      }
    }
    if (!q || seen.has(q.id)) continue;
    seen.add(q.id);
    out.push(q);
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

/** The questions actually shown on a form: everything not removed. */
export function visibleQuestions(
  questions: readonly CustomQuestion[],
): CustomQuestion[] {
  return questions.filter((q) => !q.hidden);
}

// ---------------------------------------------------------------------------
// Admin-side validation — strict, and it throws its message at the admin.
// ---------------------------------------------------------------------------

/**
 * Validate a question an admin is trying to save. Returns an error string for
 * the admin, or null when the question is fine.
 *
 * Unlike normalizeQuestion (tolerant, used on read) this is deliberately
 * unforgiving: a save is a moment where a human is present to fix the problem,
 * so a silent repair here would just hide a typo until an applicant hit it.
 */
export function validateQuestionDraft(
  q: CustomQuestion,
  otherIds: readonly string[],
): string | null {
  // A blank id usually means the LABEL is the problem: the save path fills a
  // blank id from the label before it gets here, so the only ones that survive
  // are the ones no label could name. Saying so beats the id-shape message
  // below, which would blame the admin for an id they never typed and the
  // editor promised to write for them.
  //
  // Only the two failures fillBlankQuestionIds actually hits are claimed here.
  // This function is exported for a single draft, so it can be reached without
  // that fill having run at all — and "every numbered variant is taken" would
  // then be a fabrication that sends the admin off rewording a question that
  // was fine. Anything else falls through to the id-shape message.
  if (!q.id) {
    const label = q.label.trim();
    if (!label) return "Every question needs a label.";
    const base = slugifyQuestionId(label);
    if (!base) {
      return `"${label}": there's no letter or number in this label to build a field id from. Add a word to it.`;
    }
    if (!uniqueQuestionId(label, otherIds)) {
      return `"${label}": the field id "${base}" and every numbered variant of it are taken. Reword this question.`;
    }
  }
  if (!QUESTION_ID_PATTERN.test(q.id)) {
    return `"${q.label || q.id}": the field id must start with a letter and use only lowercase letters, numbers and underscores.`;
  }
  if (RESERVED_QUESTION_IDS.includes(q.id)) {
    return `"${q.id}" is a built-in field name — pick a different one.`;
  }
  if (otherIds.includes(q.id)) {
    return `Two questions share the field id "${q.id}". Ids must be unique.`;
  }
  if (!asQuestionType(q.type)) {
    return `"${q.label}": "${q.type}" isn't a question type.`;
  }
  const label = q.label.trim();
  if (!label) return "Every question needs a label.";
  if (label.length > LABEL_MAX) {
    return `"${label.slice(0, 30)}…": label is too long (max ${LABEL_MAX}).`;
  }
  if (q.help.length > HELP_MAX) {
    return `"${label}": help text is too long (max ${HELP_MAX}).`;
  }
  if (q.placeholder.length > PLACEHOLDER_MAX) {
    return `"${label}": placeholder is too long (max ${PLACEHOLDER_MAX}).`;
  }

  if (hasOptions(q.type)) {
    if (q.options.length < 2) {
      return `"${label}": a ${QUESTION_TYPE_LABELS[q.type].toLowerCase()} needs at least two options.`;
    }
    if (q.options.length > MAX_OPTIONS) {
      return `"${label}": too many options (max ${MAX_OPTIONS}).`;
    }
    const values = new Set<string>();
    for (const o of q.options) {
      const value = o.value.trim();
      const optLabel = o.label.trim();
      if (!value || !optLabel) {
        return `"${label}": every option needs a value and a label.`;
      }
      if (optLabel.length > OPTION_LABEL_MAX) {
        return `"${label}": option label "${optLabel.slice(0, 20)}…" is too long.`;
      }
      if (values.has(value)) {
        return `"${label}": option value "${value}" is used twice.`;
      }
      values.add(value);
    }
  } else if (q.options.length > 0) {
    return `"${label}": a ${QUESTION_TYPE_LABELS[q.type].toLowerCase()} can't have options.`;
  }

  // A required question that is also removed from the form can never be
  // satisfied — every submit would fail with no way for the applicant to fix
  // it. Caught here rather than papered over at render time.
  if (q.required && q.hidden) {
    return `"${label}" is removed from the form, so it can't also be required.`;
  }

  return null;
}

/**
 * Give every id-less question in the list a key derived from its label.
 *
 * MUTATES the questions in place. That is the point: both save paths validate
 * the very array they go on to store, so filling the id here is what puts the
 * derived key in the database — a copy would be validated and thrown away.
 *
 * Typed as a mutable array for that reason. `readonly CustomQuestion[]` read as
 * a promise not to touch the input, which this function has never kept — it
 * doesn't stop the `q.id =` below, it only hides it from the caller, and a
 * caller who believed it and passed a frozen array would get a TypeError
 * thrown from inside a server action.
 *
 * One pass over the whole list rather than one question at a time, so two
 * blank rows carrying the same label get `why_now` and `why_now_2` instead of
 * both taking `why_now` and one of them being dropped as a duplicate the next
 * time the list is read.
 */
function fillBlankQuestionIds(questions: CustomQuestion[]): void {
  const taken = questions.map((q) => q.id).filter(Boolean);
  for (const q of questions) {
    // An id that exists is the jsonb key answers are already filed under. Only
    // a blank one may be written, and only once.
    if (q.id) continue;
    const id = uniqueQuestionId(q.label, taken);
    // "" is uniqueQuestionId giving up — nothing usable in the label, or the
    // collision ceiling. Leave it blank so validateQuestionDraft can say which
    // it was, rather than inventing a key that outlives the mistake.
    if (!id) continue;
    q.id = id;
    taken.push(id);
  }
}

/**
 * Validate a whole list an admin is saving. Returns the first problem, or null.
 *
 * Blank ids are filled from their labels first, IN PLACE — hence the mutable
 * parameter type. The editor derives the id when the label input loses focus,
 * but macOS Safari and Firefox don't focus a <button> on click and implicit
 * form submission doesn't blur either, so "type the label, click Save" arrives
 * here with the id still blank on the commonest browsers — and rejecting it
 * would show the admin an error about an id they were told they didn't have to
 * write.
 *
 * Whatever this fills in is now the permanent jsonb key, so every save action
 * hands the validated list back to its editor to adopt. A client that kept
 * `id: ""` after a successful save would derive a SECOND key from a reworded
 * label on the next one and orphan every answer filed under the first.
 */
export function validateQuestionList(
  questions: CustomQuestion[],
): string | null {
  if (questions.length > MAX_QUESTIONS) {
    return `Too many questions (max ${MAX_QUESTIONS}).`;
  }
  fillBlankQuestionIds(questions);
  const ids = questions.map((q) => q.id);
  for (let i = 0; i < questions.length; i += 1) {
    const others = ids.filter((_, j) => j !== i);
    const err = validateQuestionDraft(questions[i], others);
    if (err) return err;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Answer side — what an applicant submitted.
// ---------------------------------------------------------------------------

export type AnswerValue = string | number | boolean;
export type AnswerMap = Record<string, AnswerValue>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when a submitted value counts as "they left it blank". */
export function isBlankAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  // `false` on a checkbox is a real answer to "did you tick it", but it is
  // also what an unticked required checkbox looks like — and a required
  // checkbox means "you must agree", so false has to read as blank there.
  if (typeof value === "boolean") return value === false;
  if (typeof value === "number") return Number.isNaN(value);
  return false;
}

/**
 * Validate one answer against its question. Returns a message for the
 * applicant, or null.
 *
 * Applicant-facing copy: it names the question by its label, never by its id,
 * and never quotes what they typed back at them.
 */
export function answerError(
  q: CustomQuestion,
  raw: unknown,
): string | null {
  if (q.hidden) return null;

  const blank = isBlankAnswer(raw);
  if (blank) {
    if (!q.required) return null;
    return q.type === "checkbox"
      ? `Please confirm "${q.label}".`
      : `"${q.label}" is required.`;
  }

  switch (q.type) {
    case "checkbox":
      if (typeof raw !== "boolean") return `"${q.label}": expected yes or no.`;
      return null;

    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return `"${q.label}": enter a number.`;
      return null;
    }

    case "email": {
      const s = String(raw).trim();
      if (s.length > TEXT_ANSWER_MAX) return `"${q.label}": that's too long.`;
      if (!EMAIL_RE.test(s)) return `"${q.label}": enter a valid email address.`;
      return null;
    }

    case "url": {
      const s = String(raw).trim();
      if (s.length > TEXT_ANSWER_MAX) return `"${q.label}": that's too long.`;
      // Accept a bare domain — applicants type "myproject.com" constantly, and
      // rejecting it teaches them nothing. normalizeAnswers adds the scheme.
      if (!/^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/.test(s)) {
        return `"${q.label}": enter a valid link.`;
      }
      return null;
    }

    case "date": {
      const s = String(raw).trim();
      if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) {
        return `"${q.label}": enter a valid date.`;
      }
      return null;
    }

    case "select":
    case "radio": {
      const s = String(raw);
      if (!q.options.some((o) => o.value === s)) {
        return `"${q.label}": pick one of the listed options.`;
      }
      return null;
    }

    case "textarea": {
      const s = String(raw);
      if (s.length > TEXTAREA_ANSWER_MAX) {
        return `"${q.label}": that's too long (max ${TEXTAREA_ANSWER_MAX} characters).`;
      }
      return null;
    }

    case "text":
    default: {
      const s = String(raw);
      if (s.length > TEXT_ANSWER_MAX) {
        return `"${q.label}": that's too long (max ${TEXT_ANSWER_MAX} characters).`;
      }
      return null;
    }
  }
}

/** Coerce one validated answer into the shape stored in jsonb. */
function coerceAnswer(q: CustomQuestion, raw: unknown): AnswerValue | null {
  if (isBlankAnswer(raw)) return null;
  switch (q.type) {
    case "checkbox":
      return raw === true;
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : null;
    }
    case "url": {
      const s = String(raw).trim();
      return /^https?:\/\//i.test(s) ? s : `https://${s}`;
    }
    case "textarea":
      return String(raw).slice(0, TEXTAREA_ANSWER_MAX);
    default:
      return String(raw).trim().slice(0, TEXT_ANSWER_MAX);
  }
}

export type AnswerCheck =
  | { ok: true; answers: AnswerMap }
  | { ok: false; error: string; errors: Record<string, string> };

/**
 * Validate and clean a whole answer blob against a question list.
 *
 * Only keys belonging to a live, visible question survive — an extra key in
 * the POST body is dropped rather than rejected, so a stale browser tab whose
 * form still has a question the admin deleted an hour ago can still submit.
 * The alternative (reject the whole submission) loses the applicant's essay
 * over an admin's edit, which is never the right trade.
 *
 * `partial: true` skips required-checks. That is the draft-autosave path:
 * /apply saves every few seconds, and enforcing "required" on a half-typed
 * form would make autosave fail continuously.
 */
export function checkAnswers(
  questions: readonly CustomQuestion[],
  raw: unknown,
  opts: { partial?: boolean } = {},
): AnswerCheck {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const answers: AnswerMap = {};
  const errors: Record<string, string> = {};
  let first = "";

  for (const q of questions) {
    if (q.hidden) continue;
    const value = input[q.id];
    if (opts.partial && isBlankAnswer(value)) continue;

    const err = answerError(q, value);
    if (err) {
      errors[q.id] = err;
      if (!first) first = err;
      continue;
    }
    const clean = coerceAnswer(q, value);
    if (clean !== null) answers[q.id] = clean;
  }

  if (first) return { ok: false, error: first, errors };
  return { ok: true, answers };
}

/**
 * The two prefixes /apply posts under. Exported so the form and the server
 * action can't disagree about them — a mismatch would silently drop every
 * answer rather than failing loudly.
 */
export const CUSTOM_PREFIX = "custom";
export const SCHOLARSHIP_PREFIX = "sch";

/**
 * The form field name a question's answer is posted under.
 *
 * Prefixed so a custom question can never collide with one of the built-in,
 * column-backed field names in the same FormData — `checkAnswers` would
 * happily accept `full_name` as a custom answer otherwise, and the applicant's
 * real name would end up in the jsonb blob instead of its column.
 */
export function fieldName(prefix: string, id: string): string {
  return `${prefix}__${id}`;
}

/**
 * Pull this question set's answers out of a flat form payload.
 *
 * Handles the one genuinely awkward thing about HTML forms: an unchecked
 * checkbox is ABSENT from FormData rather than present-and-false. Left to
 * `checkAnswers`, absence and "unticked" would both read as blank, which is
 * correct — but only because this function turns presence into `true` first.
 * Without it a ticked box would arrive as the string "on" and fail the
 * boolean check.
 */
export function readAnswers(
  questions: readonly CustomQuestion[],
  entries: Readonly<Record<string, unknown>>,
  prefix: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of questions) {
    if (q.hidden) continue;
    const raw = entries[fieldName(prefix, q.id)];
    if (q.type === "checkbox") {
      // "on" is what a bare <input type=checkbox> posts; "false" is what a
      // controlled hidden input would send for an explicit no.
      out[q.id] =
        raw !== undefined && raw !== null && raw !== "" && raw !== "false";
      continue;
    }
    if (raw === undefined) continue;
    out[q.id] = raw;
  }
  return out;
}

/**
 * Render a stored answer for the admin review queue and CSV export.
 *
 * Returns "" for an unanswered optional question so a review page can skip the
 * row entirely rather than printing "Biggest risk: —" fifteen times.
 */
export function formatAnswer(
  q: CustomQuestion,
  answers: Readonly<Record<string, unknown>> | null | undefined,
): string {
  const value = answers?.[q.id];
  if (value === null || value === undefined || value === "") return "";
  if (q.type === "checkbox") return value === true ? "Yes" : "No";
  if (hasOptions(q.type)) {
    const match = q.options.find((o) => o.value === String(value));
    return match ? match.label : String(value);
  }
  return String(value);
}

/**
 * An empty question, ready for the admin editor's "Add question" button.
 * `id` is left blank: it is derived from the label — in the editor when the
 * label input loses focus, and again on the save path, which is the derivation
 * that actually has to happen.
 */
export function blankQuestion(type: QuestionType = "text"): CustomQuestion {
  return {
    id: "",
    type,
    label: "",
    help: "",
    placeholder: "",
    required: false,
    hidden: false,
    options: hasOptions(type)
      ? [
          { value: "option_1", label: "" },
          { value: "option_2", label: "" },
        ]
      : [],
  };
}
