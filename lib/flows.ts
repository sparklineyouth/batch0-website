// ---------------------------------------------------------------------------
// "Before One" flow engine — shared types + pure helpers.
//
// A flow is an admin-curated, multi-step interactive experience (diagnostic,
// challenge, guided worksheet). Steps come in five kinds; choice options can
// jump to any step_key, which is how a flow personalizes ("no idea yet" vs
// "already building" take different routes to different outcomes).
//
// Imported by the student player (client), the admin builder (client), server
// actions, and scripts/seed-flows.mts — keep it dependency-free.
// ---------------------------------------------------------------------------

export type FlowStage = "explore" | "prove" | "prepare";
export type FlowStatus = "draft" | "published" | "archived";
export type StepKind = "content" | "choice" | "input" | "checklist" | "outcome";

export const FLOW_STAGES: {
  value: FlowStage;
  label: string;
  blurb: string;
}[] = [
  {
    value: "explore",
    label: "Explore",
    blurb: "Find a problem worth your time.",
  },
  {
    value: "prove",
    label: "Prove",
    blurb: "Collect evidence, not compliments.",
  },
  {
    value: "prepare",
    label: "Prepare",
    blurb: "Arrive at kickoff ready to build.",
  },
];

export const STEP_KINDS: { value: StepKind; label: string; hint: string }[] = [
  { value: "content", label: "Content", hint: "Markdown page with a Continue button" },
  { value: "choice", label: "Choice", hint: "One question, options can branch to any step" },
  { value: "input", label: "Input", hint: "Free-text fields; answers feed the outcome" },
  { value: "checklist", label: "Checklist", hint: "Tick-off items, optionally all required" },
  { value: "outcome", label: "Outcome", hint: "Personalized ending; completes the flow" },
];

/** One selectable option on a choice step. */
export type ChoiceOption = {
  value: string;
  label: string;
  description?: string;
  /** step_key to jump to when picked; defaults to the next step in order. */
  next?: string;
};

/** One free-text field on an input step. */
export type InputField = {
  key: string;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
  /**
   * Garbage phrases: if the answer contains one (case-insensitive), the
   * player shows a non-blocking warning. Powers the one-sentence builder's
   * "for everyone / all-in-one / revolutionary" linting.
   */
  flags?: string[];
};

/** One tickable item on a checklist step. */
export type ChecklistItem = { key: string; label: string; hint?: string };

/**
 * One conditional block of an outcome step. Rendered when `when` is absent
 * or the recorded answer for `when.step` is in `when.in`. Bodies are
 * markdown and may reference answers: {{step_key}} for a choice's label or
 * a single-field input, {{step_key.field}} for a specific input field.
 */
export type OutcomeBlock = {
  when?: { step: string; in: string[] };
  title?: string;
  body: string;
};

/** Kind-specific step configuration, stored as jsonb. */
export type StepConfig = {
  /** Explicit next step_key (content/input/checklist); default = next in order. */
  next?: string;
  /** choice */
  options?: ChoiceOption[];
  /** input */
  fields?: InputField[];
  /** checklist */
  items?: ChecklistItem[];
  requireAll?: boolean;
  /** outcome */
  blocks?: OutcomeBlock[];
};

export type FlowStepData = {
  step_key: string;
  title: string | null;
  kind: StepKind;
  body: string | null;
  config: StepConfig;
  sort_order: number;
};

export type FlowMeta = {
  id?: string;
  slug: string;
  title: string;
  tagline: string | null;
  stage: FlowStage;
  status: FlowStatus;
  est_minutes: number | null;
  sort_order: number;
  cohort_id: string | null;
};

/**
 * Answers, keyed by step_key:
 *  - choice     -> the chosen option's value (string)
 *  - input      -> { [fieldKey]: text }
 *  - checklist  -> array of checked item keys
 */
export type FlowAnswers = Record<
  string,
  string | string[] | Record<string, string>
>;

/**
 * The minimal step shape the pure helpers need — the player's compiled
 * steps (markdown pre-rendered, no raw body) satisfy it structurally.
 */
export type StepRef = Pick<
  FlowStepData,
  "step_key" | "kind" | "config" | "sort_order"
>;

/** The step the player starts (or falls back) on. */
export function firstStepKey(steps: StepRef[]): string | null {
  const sorted = [...steps].sort((a, b) => a.sort_order - b.sort_order);
  return sorted[0]?.step_key ?? null;
}

/** Next step by sort order — used when no explicit jump is configured. */
export function nextStepKeyByOrder(
  steps: StepRef[],
  current: string,
): string | null {
  const sorted = [...steps].sort((a, b) => a.sort_order - b.sort_order);
  const i = sorted.findIndex((s) => s.step_key === current);
  if (i === -1 || i + 1 >= sorted.length) return null;
  return sorted[i + 1].step_key;
}

/** Does the recorded answer satisfy an outcome block's condition? */
export function outcomeBlockMatches(
  block: OutcomeBlock,
  answers: FlowAnswers,
): boolean {
  if (!block.when) return true;
  const a = answers[block.when.step];
  return typeof a === "string" && block.when.in.includes(a);
}

/**
 * Resolve a {{step}} / {{step.field}} placeholder to display text.
 * Choice answers resolve to the option's label; checklists to a count.
 */
export function resolveAnswer(
  steps: StepRef[],
  answers: FlowAnswers,
  stepKey: string,
  field?: string,
): string | null {
  const answer = answers[stepKey];
  if (answer == null) return null;
  if (typeof answer === "string") {
    const step = steps.find((s) => s.step_key === stepKey);
    const opt = step?.config.options?.find((o) => o.value === answer);
    return opt?.label ?? answer;
  }
  if (Array.isArray(answer)) return String(answer.length);
  if (field) return answer[field] ?? null;
  // Single-field input referenced without a field name.
  const values = Object.values(answer).filter(Boolean);
  return values.length === 1 ? values[0] : values.join("; ") || null;
}

const PLACEHOLDER_RE =
  /\{\{\s*([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?\s*\}\}/g;

/**
 * Substitute {{step}} / {{step.field}} placeholders. `escape` lets the
 * player HTML-escape values when substituting into compiled HTML.
 */
export function renderTemplate(
  text: string,
  steps: StepRef[],
  answers: FlowAnswers,
  escape: (s: string) => string = (s) => s,
): string {
  return text.replace(PLACEHOLDER_RE, (_m, stepKey, field) => {
    const v = resolveAnswer(steps, answers, stepKey, field);
    return v == null || v === "" ? "—" : escape(v);
  });
}

/** Case-insensitive garbage-phrase scan for input linting. */
export function flaggedPhrases(value: string, flags?: string[]): string[] {
  if (!flags?.length || !value) return [];
  const lower = value.toLowerCase();
  return flags.filter((f) => lower.includes(f.toLowerCase()));
}

/** slugify a title for slugs / step keys / option values. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
