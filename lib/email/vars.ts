/**
 * Merge-tag interpolation.
 *
 * Templates are written by admins in the rich-text editor and carry
 * `{{first_name}}`-style tags. This module is the one place that decides what
 * a tag means, which matters because the same substitution runs against three
 * different sinks — the subject line (plain text), the body (HTML), and the
 * preview (HTML with sample data) — and they must agree, or what an admin
 * previews isn't what a recipient gets.
 *
 * Import-free on purpose: `npm test` runs this file directly through Node's
 * type stripping, and the editor imports it in the browser to highlight
 * unknown tags as you type.
 */

/** What a template declares it needs. Stored on the row as `variables`. */
export type VariableDef = {
  key: string;
  label: string;
  /** Shown in the editor's insert menu and used to render the preview. */
  example: string;
  /** A send that can't fill this one is held rather than sent half-blank. */
  required?: boolean;
};

export type VariableValues = Record<string, string | number | null | undefined>;

/** `{{ tag }}` — whitespace tolerated, dots allowed for namespaced tags. */
const TAG_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

/** Every tag a body actually uses, in first-appearance order. */
export function extractTags(...sources: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of sources) {
    if (!src) continue;
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(src))) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stringify(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Substitute tags in `input`.
 *
 * `{{name|there}}` supplies an inline fallback, which is what makes a single
 * template work for someone who gave us a name and someone who didn't —
 * without it, every optional field needs two templates or a visibly empty
 * greeting.
 *
 * `escape` must be on for HTML sinks. Values come from user-controlled
 * profile data (a display name is whatever someone typed at signup), so an
 * unescaped substitution into the body would be stored XSS that we render
 * ourselves and mail out.
 */
export function interpolate(
  input: string,
  values: VariableValues,
  opts: { escape: boolean } = { escape: true },
): string {
  if (!input) return "";
  return input.replace(TAG_RE, (whole, key: string, fallback?: string) => {
    const resolved = stringify(values[key]) ?? stringify(fallback ?? null);
    // An unresolved tag is left verbatim rather than blanked. A visible
    // `{{cohort_name}}` in a test send is a bug report; a silent empty gap is
    // a sentence that reads fine and says nothing.
    if (resolved === null) return whole;
    return opts.escape ? escapeHtml(resolved) : resolved;
  });
}

/** The declared-but-unfilled required tags, so a send can refuse to go out. */
export function missingRequired(
  declared: readonly VariableDef[],
  values: VariableValues,
): string[] {
  return declared
    .filter((d) => d.required && stringify(values[d.key]) === null)
    .map((d) => d.key);
}

/** Sample values for the preview pane, declared examples first. */
export function exampleValues(
  declared: readonly VariableDef[],
  usedTags: readonly string[] = [],
): VariableValues {
  const out: VariableValues = {};
  for (const d of declared) out[d.key] = d.example || d.label || d.key;
  // A tag the admin typed but never declared still needs *something* in the
  // preview, or the pane shows raw braces and the layout can't be judged.
  for (const t of usedTags) {
    if (!(t in out)) out[t] = GENERIC_EXAMPLES[t] ?? `[${t}]`;
  }
  return out;
}

/** Sensible sample values for the tags nearly every template ends up using. */
const GENERIC_EXAMPLES: Record<string, string> = {
  first_name: "Alex",
  full_name: "Alex Rivera",
  name: "Alex",
  email: "alex@example.com",
  cohort_name: "Cohort 1",
  amount: "$130",
  site_url: "https://batch0.org",
  dashboard_url: "https://batch0.org/dashboard",
  parent_name: "Sam Rivera",
  student_name: "Alex",
  deadline: "September 10, 2026",
  team_name: "Northstar",
};

/** "Alex Rivera" -> "Alex"; blank -> the fallback, never an empty greeting. */
export function firstNameOf(
  full: string | null | undefined,
  fallback = "there",
): string {
  const first = (full ?? "").trim().split(/\s+/)[0];
  return first || fallback;
}

/**
 * Validate a merge-tag key typed into the variables editor.
 *
 * Restricted to the shape TAG_RE matches, because a declared variable that
 * the interpolator can't see is a field an admin fills in and then watches do
 * nothing.
 */
export const VARIABLE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.]{0,48}$/;

export function isValidVariableKey(key: string): boolean {
  return VARIABLE_KEY_PATTERN.test(key);
}
