import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeQuestions, type CustomQuestion } from "@/lib/question-schema";

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

export {
  QUESTION_FIELDS,
  QUESTION_FIELD_MAP,
  REQUIRED_CORE_KEYS,
  isRequiredCore,
  type MergedQuestion,
  type QuestionConfig,
  type QuestionFieldType,
  type QuestionOverride,
  type RequiredCoreKey,
} from "@/lib/application-fields";
import {
  QUESTION_FIELDS,
  isRequiredCore,
  type MergedQuestion,
  type QuestionConfig,
  type QuestionOverride,
} from "@/lib/application-fields";

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
 * /apply asks `builtins` in a fixed, hand-ordered sequence with conditional
 * logic (parent_email only for under-18s; city + country on one screen) and
 * then `custom`, one screen each, after them — see buildScreens() in
 * lib/apply-flow.ts. That is why custom questions carry an order among
 * themselves but are not interleaved with the built-ins.
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
