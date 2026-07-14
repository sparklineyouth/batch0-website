import { createAdminClient } from "@/lib/supabase/admin";

// ---------------------------------------------------------------------------
// Admin-editable application questions.
//
// The application form (app/apply/application-form.tsx) has a FIXED skeleton
// of 16 fields. Each field maps 1:1 to a column on the `applications` table.
// Admins can edit the *content* of each question — the label, help text,
// placeholder, whether it's required, whether it's hidden, and (for the
// team_size choice field) the option LABELS. Admins CANNOT add, remove,
// reorder, or change field keys / types / option values — those are load-
// bearing for the DB mapping and the server-side SubmitSchema.
//
// Overrides live in a single `site_settings` row (key = 'application_questions',
// value = jsonb), mirroring how getSiteConfig reads site_settings. On read we
// deep-merge overrides onto the code defaults for KNOWN keys only and ignore
// anything unexpected, so a malformed / stale config can never break /apply.
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
    placeholder: "What do you want to get out of these 4 weeks?",
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

/**
 * Resolve the full set of application questions: code defaults deep-merged with
 * admin overrides from `site_settings.application_questions`. Never throws —
 * returns the defaults on any read/parse error so /apply can't be broken by a
 * malformed config. Reads via the service-role client (like getSiteConfig).
 */
export async function getApplicationQuestions(): Promise<MergedQuestion[]> {
  let overrides: ApplicationQuestionsOverrides = {};
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("site_settings")
      .select("value")
      .eq("key", "application_questions")
      .maybeSingle();
    const raw = data?.value;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      // Keep only known keys; ignore anything unexpected.
      for (const [key, val] of Object.entries(
        raw as Record<string, unknown>,
      )) {
        if (VALID_KEYS.has(key) && val && typeof val === "object") {
          overrides[key] = val as QuestionOverride;
        }
      }
    }
  } catch (err) {
    // Swallow — defaults are a safe fallback. Log for observability.
    console.error("[application-questions] read failed:", err);
    overrides = {};
  }

  return QUESTION_FIELDS.map((base) => mergeField(base, overrides[base.key]));
}
