// ---------------------------------------------------------------------------
// Resources search — shared, pure logic.
//
// /dashboard/resources lists every resource the viewer may open (RLS decides,
// migration 0046) under category headings, and nothing else helped find one:
// a student looking for "the pitch deck template" from week one scrolled.
// The search row narrows that same list by `?q=` and `?shelf=`; it never
// widens it. Rows still open through /dashboard/resources/open/[id], which
// re-reads the row with the student's own client, so search adds no new way
// to reach a file.
//
// Imported by a server page and a client form — keep it dependency-free.
// ---------------------------------------------------------------------------

/** Longest query kept. Past this it is a paste, not a search. */
export const RESOURCE_QUERY_MAX = 80;

/**
 * The shelf value for pre-cohort material (the Before One worksheets and the
 * pre-cohort resources). Not a category: `resources.pre_cohort` is its own
 * flag, and those rows render under their own heading whatever their category.
 */
export const PRE_COHORT_SHELF = "pre-cohort";

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/** `?q=`: trimmed, inner whitespace collapsed, capped. "" for none. */
export function parseResourceQuery(raw: string | string[] | undefined): string {
  return first(raw).replace(/\s+/g, " ").trim().slice(0, RESOURCE_QUERY_MAX).trim();
}

/**
 * `?shelf=`, only if it is one the page actually has. Anything else (a shelf
 * that was emptied, a hand-edited URL) reads as no filter rather than as an
 * empty page.
 */
export function parseResourceShelf(
  raw: string | string[] | undefined,
  shelves: readonly string[],
): string | null {
  const v = first(raw).trim();
  return v && shelves.includes(v) ? v : null;
}

/** Lowercased, accents folded: "Résumé" finds "resume" and back. */
function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Whether every word of `q` appears somewhere in `fields` (title,
 * description, category…). Words, not the phrase: "deck pitch" finds
 * "Pitch deck template". An empty query matches everything.
 */
export function matchesResourceQuery(
  fields: readonly (string | null | undefined)[],
  q: string,
): boolean {
  const terms = fold(q).split(" ").filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = fold(fields.filter(Boolean).join(" \n "));
  return terms.every((t) => haystack.includes(t));
}

/** The page's URL for a search. Empty parts stay out of it. */
export function resourcesHref(opts: { q?: string; shelf?: string | null }): string {
  const params = new URLSearchParams();
  const q = (opts.q ?? "").trim();
  if (q) params.set("q", q);
  if (opts.shelf) params.set("shelf", opts.shelf);
  const qs = params.toString();
  return qs ? `/dashboard/resources?${qs}` : "/dashboard/resources";
}
