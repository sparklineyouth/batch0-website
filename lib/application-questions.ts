import { createAdminClient } from "@/lib/supabase/admin";
import {
  normalizeQuestions,
  visibleQuestions,
  type CustomQuestion,
} from "@/lib/question-schema";

// ---------------------------------------------------------------------------
// Admin-editable application questions.
//
// There are two kinds of question on /apply, and the difference is not
// cosmetic — it's where the answer goes:
//
//   BUILT-IN (17 of them)  Each maps 1:1 to a COLUMN on `applications`. Their
//                          keys, types and option VALUES are frozen, because
//                          the column mapping and the server-side SubmitSchema
//                          are built on them. An admin can edit every piece of
//                          content — label, help, placeholder, required — and
//                          can REMOVE one, which takes it off the form and
//                          stops collecting it while leaving every answer
//                          already in that column readable. Removal is
//                          `hidden`, never a DROP COLUMN: past applications
//                          keep their data.
//
//   CUSTOM (any number)    Added by an admin, answered into the
//                          `applications.custom_answers` jsonb blob keyed by
//                          question id (migration 0071). These can be added,
//                          edited, reordered and genuinely deleted, because
//                          nothing structural hangs off them.
//
// The five server-authoritative cores (full_name, age, phone, why_join,
// team_size) are locked in both directions — never optional, never removed.
// SubmitSchema enforces them, so an admin hiding one would only produce
// submissions the server then rejects, with nothing on screen explaining why.
//
// STORAGE. One `site_settings` row (key = 'application_questions'), mirroring
// how getSiteConfig reads site_settings. The value is a v2 object:
//
//   { version: 2, builtins: { [key]: QuestionOverride }, custom: Question[] }
//
// A bare `{ [key]: QuestionOverride }` — the v1 shape, which is what is in the
// database today — is read as `builtins` with no custom questions, so this
// change needs no data migration and an older build reading a v2 row simply
// ignores the keys it doesn't know.
//
// Every read is tolerant: unknown keys, malformed entries and a completely
// unparseable row all degrade to "use the code defaults" rather than throwing.
// /apply is the top of the funnel; it does not get to 500 because of a bad
// config write.
// ---------------------------------------------------------------------------

export type QuestionFieldType =
  | "text"
  | "number"
  | "textarea"
  | "email"
  | "url"
  | "radiogroup";

/** The immutable definition of a single field — its default content. */
export type QuestionConfig = {
  /** Column key on the applications table. Never editable. */
  key: string;
  /** Input type. Never editable. */
  type: QuestionFieldType;
  label: string;
  /** Help / description text shown under the field. "" = none. */
  help: string;
  /** Placeholder text for text-like inputs. "" = none. */
  placeholder: string;
  /** Whether the field is required (client-side marker + validation). */
  required: boolean;
  /** Whether the field is hidden from the form entirely. */
  hidden: boolean;
  /** For radiogroup fields only: the fixed option values + default labels. */
  options?: { value: number; label: string }[];
};

/** The admin-editable slice of a field. Persisted (per key) in site_settings. */
export type QuestionOverride = {
  label?: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  hidden?: boolean;
  /** Map of option VALUE -> new LABEL. Only labels are editable. */
  optionLabels?: Record<string, string>;
};

/** The merged shape handed to the form + admin editor. Same as QuestionConfig
 *  but guaranteed to reflect any admin overrides. */
export type MergedQuestion = QuestionConfig;

// The four server-authoritative required fields. These can never be hidden and
// always stay required regardless of what an override says — the server's
// SubmitSchema enforces them, so letting an admin hide/optional them would only
// produce broken submissions. (parent_email's age-conditional rule is layered
// on separately in the form and is NOT one of these unconditional cores.)
export const REQUIRED_CORE_KEYS = [
  "full_name",
  "age",
  "phone",
  "why_join",
  "team_size",
] as const;

export type RequiredCoreKey = (typeof REQUIRED_CORE_KEYS)[number];

export function isRequiredCore(key: string): boolean {
  return (REQUIRED_CORE_KEYS as readonly string[]).includes(key);
}

// The fixed skeleton. Order + keys + types + option values are frozen. The
// label/help/placeholder/required/hidden values here are the seed defaults and
// MUST byte-match the current hardcoded form (see migration 0035, which seeds
// the same content so today's form renders identically before any admin edit).
export const QUESTION_FIELDS: readonly QuestionConfig[] = Object.freeze([
  {
    key: "full_name",
    type: "text",
    label: "Full name",
    help: "",
    placeholder: "",
    required: true,
    hidden: false,
  },
  {
    key: "age",
    type: "number",
    label: "Age",
    help: "",
    placeholder: "",
    required: true,
    hidden: false,
  },
  {
    key: "grade",
    type: "text",
    label: "Grade",
    help: "",
    placeholder: "e.g. 11th",
    required: false,
    hidden: false,
  },
  {
    key: "school",
    type: "text",
    label: "School",
    help: "",
    placeholder: "",
    required: false,
    hidden: false,
  },
  {
    key: "city",
    type: "text",
    label: "City",
    help: "",
    placeholder: "",
    required: false,
    hidden: false,
  },
  {
    key: "country",
    type: "text",
    label: "Country",
    help: "",
    placeholder: "",
    required: false,
    hidden: false,
  },
  {
    key: "phone",
    type: "text",
    label: "Phone number",
    help: "So we can reach you about your application and the program.",
    placeholder: "+1 (555) 123-4567",
    required: true,
    hidden: false,
  },
  {
    key: "parent_email",
    type: "email",
    label: "Parent / guardian email",
    help: "For applicants under 18, we email your parent/guardian a short note about the program once you submit.",
    placeholder: "Optional — only needed if you're under 18",
    required: false,
    hidden: false,
  },
  {
    key: "experience",
    type: "textarea",
    label: "Tell us about your relevant experience",
    help: "",
    placeholder:
      "Past projects, clubs, jobs, hackathons, side hustles — anything.",
    required: false,
    hidden: false,
  },
  {
    key: "hours_per_week",
    type: "number",
    label: "Hours per week you can commit",
    help: "",
    placeholder: "10",
    required: false,
    hidden: false,
  },
  {
    key: "referral_source",
    type: "text",
    label: "How did you hear about us?",
    help: "",
    placeholder: "",
    required: false,
    hidden: false,
  },
  {
    key: "linkedin_url",
    type: "url",
    label: "LinkedIn",
    help: "",
    placeholder: "https://linkedin.com/in/…",
    required: false,
    hidden: false,
  },
  {
    key: "resume_url",
    type: "url",
    label: "Resume URL",
    help: "",
    placeholder: "https://… (Google Drive, Dropbox, your site)",
    required: false,
    hidden: false,
  },
  {
    key: "portfolio_url",
    type: "url",
    label: "Portfolio / project link",
    help: "",
    placeholder: "https://…",
    required: false,
    hidden: false,
  },
  {
    key: "why_join",
    type: "textarea",
    label: "Why batch0?",
    help: "",
    // No duration claim — the cohort runs ~9 weeks (Aug 17 → Oct 18), so the
    // old "these 4 weeks" was wrong.
    placeholder: "What do you want to get out of the program?",
    required: true,
    hidden: false,
  },
  {
    key: "startup_idea",
    type: "textarea",
    label: "Do you have a project idea? (optional)",
    help: "",
    placeholder:
      "It's totally fine if you don't. Tell us anything you've been thinking about.",
    required: false,
    hidden: false,
  },
  {
    key: "team_size",
    type: "radiogroup",
    label: "Founding team size",
    help: "How many of you are working on this together? You don't need to list anyone — just the count, including yourself.",
    placeholder: "",
    required: true,
    hidden: false,
    options: [
      { value: 1, label: "Solo (just me)" },
      { value: 2, label: "2 (me + 1 co-founder)" },
      { value: 3, label: "3" },
      { value: 4, label: "4" },
      { value: 5, label: "5+" },
    ],
  },
]);

/** Fast lookup of the frozen skeleton by key. */
export const QUESTION_FIELD_MAP: Record<string, QuestionConfig> =
  Object.fromEntries(QUESTION_FIELDS.map((f) => [f.key, f]));

const VALID_KEYS = new Set(QUESTION_FIELDS.map((f) => f.key));

/**
 * Apply the guardrails a merged field must always satisfy, regardless of what
 * an override says: the four server-required cores are never hidden and always
 * required. Returns a NEW object (never mutates the input).
 */
function applyGuardrails(field: QuestionConfig): QuestionConfig {
  if (isRequiredCore(field.key)) {
    return { ...field, required: true, hidden: false };
  }
  return field;
}

/**
 * Deep-merge one override onto a default field for a KNOWN key. Unknown /
 * malformed override properties are ignored. Types + keys + option values are
 * never touched — only content.
 */
function mergeField(
  base: QuestionConfig,
  override: QuestionOverride | undefined,
): QuestionConfig {
  if (!override || typeof override !== "object") {
    return applyGuardrails({ ...base });
  }
  const merged: QuestionConfig = { ...base };
  if (typeof override.label === "string") merged.label = override.label;
  if (typeof override.help === "string") merged.help = override.help;
  if (typeof override.placeholder === "string") {
    merged.placeholder = override.placeholder;
  }
  if (typeof override.required === "boolean") {
    merged.required = override.required;
  }
  if (typeof override.hidden === "boolean") merged.hidden = override.hidden;

  // Option LABELS only — keep the fixed option VALUES + order from the base.
  if (base.options && override.optionLabels) {
    merged.options = base.options.map((opt) => {
      const next = override.optionLabels?.[String(opt.value)];
      return typeof next === "string" && next.trim().length > 0
        ? { ...opt, label: next }
        : { ...opt };
    });
  } else if (base.options) {
    merged.options = base.options.map((o) => ({ ...o }));
  }

  return applyGuardrails(merged);
}

export type ApplicationQuestionsOverrides = Record<string, QuestionOverride>;

/** The `site_settings.application_questions` value, v2. */
export type ApplicationQuestionsConfig = {
  version: 2;
  builtins: ApplicationQuestionsOverrides;
  custom: CustomQuestion[];
};

export const APPLICATION_QUESTIONS_SETTING = "application_questions";

/**
 * Parse the stored value, accepting both the v2 object and the bare v1 map.
 *
 * Tolerant at every branch — this runs on /apply's render path. The worst
 * outcome of a malformed row must be "the form looks like the code defaults",
 * never an exception.
 */
export function parseQuestionsConfig(raw: unknown): ApplicationQuestionsConfig {
  const empty: ApplicationQuestionsConfig = {
    version: 2,
    builtins: {},
    custom: [],
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;

  const obj = raw as Record<string, unknown>;
  // v2: an explicit envelope.
  const isV2 =
    obj.version === 2 ||
    Object.prototype.hasOwnProperty.call(obj, "builtins") ||
    Object.prototype.hasOwnProperty.call(obj, "custom");

  // v1 (what's in the database today): the bare override map, no envelope.
  const builtinSource = isV2 ? obj.builtins : obj;
  const builtins: ApplicationQuestionsOverrides = {};
  if (builtinSource && typeof builtinSource === "object" && !Array.isArray(builtinSource)) {
    for (const [key, val] of Object.entries(builtinSource as Record<string, unknown>)) {
      // Known keys only. An override naming a field this build doesn't have —
      // left behind by a rollback, say — is ignored rather than rendered.
      if (VALID_KEYS.has(key) && val && typeof val === "object") {
        builtins[key] = val as QuestionOverride;
      }
    }
  }

  return {
    version: 2,
    builtins,
    custom: isV2 ? normalizeQuestions(obj.custom) : [],
  };
}

async function readQuestionsConfig(): Promise<ApplicationQuestionsConfig> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("site_settings")
      .select("value")
      .eq("key", APPLICATION_QUESTIONS_SETTING)
      .maybeSingle();
    return parseQuestionsConfig(data?.value);
  } catch (err) {
    // Swallow — defaults are a safe fallback. Log for observability.
    console.error("[application-questions] read failed:", err);
    return { version: 2, builtins: {}, custom: [] };
  }
}

/**
 * The 17 built-in questions, code defaults deep-merged with admin overrides.
 *
 * Returns ALL of them, including ones an admin has removed — callers filter on
 * `hidden` themselves, because the admin editor needs to render a removed
 * field in order to offer putting it back.
 */
export async function getApplicationQuestions(): Promise<MergedQuestion[]> {
  const config = await readQuestionsConfig();
  return QUESTION_FIELDS.map((base) => mergeField(base, config.builtins[base.key]));
}

export type ApplicationForm = {
  /** All 17, merged. Includes removed ones — check `hidden`. */
  builtins: MergedQuestion[];
  /** Admin-added questions, in the order the admin arranged them. */
  custom: CustomQuestion[];
};

/**
 * Everything /apply and the admin editor need, in one read.
 *
 * The form renders `builtins` through its existing bespoke layout (the fields
 * sit in hand-built sections with conditional logic, e.g. parent_email
 * appearing only under 18) and then renders `custom` as its own section. That
 * is why custom questions carry an order among themselves but are not
 * interleaved with the built-ins: the built-in layout is not a generic list,
 * and pretending it is would break the grid pairs and the conditional fields.
 */
export async function getApplicationForm(): Promise<ApplicationForm> {
  const config = await readQuestionsConfig();
  return {
    builtins: QUESTION_FIELDS.map((base) =>
      mergeField(base, config.builtins[base.key]),
    ),
    custom: config.custom,
  };
}

/** Just the custom questions an applicant should actually be shown. */
export async function getVisibleCustomQuestions(): Promise<CustomQuestion[]> {
  return visibleQuestions((await readQuestionsConfig()).custom);
}
