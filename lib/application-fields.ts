// ---------------------------------------------------------------------------
// The 17 built-in, column-backed application fields — definitions only.
//
// Split out of lib/application-questions.ts so the pieces that are pure data
// (the frozen skeleton, the required cores, the types) can be imported by code
// that must not pull in a Supabase client: the /apply client component, and
// lib/apply-flow.ts, whose tests run under Node's native type stripping and so
// cannot resolve the `@/` alias that lib/application-questions.ts imports
// through. lib/application-questions.ts re-exports everything here, so every
// existing import keeps working unchanged.
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
