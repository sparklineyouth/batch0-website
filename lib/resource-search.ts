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

/**
 * `?q=`: trimmed, inner whitespace collapsed, capped. "" for none.
 *
 * The search box normalises what it types with this same function before
 * comparing it with, or writing it to, the URL. A box that kept "pitch  deck"
 * while the page answered "pitch deck" read the two as a change made
 * elsewhere and overwrote whatever was typed in between.
 */
export function parseResourceQuery(raw: string | string[] | undefined): string {
  return first(raw).replace(/\s+/g, " ").trim().slice(0, RESOURCE_QUERY_MAX).trim();
}

export type ResourceShelfOption = { value: string; label: string };

/**
 * The shelf picker's options, in page order: the pre-cohort block when the
 * page has one, then the categories. Category is free text, so an admin can
 * file something under "pre-cohort" itself. That category shares the
 * pre-cohort shelf (one option, and picking it shows both) rather than being
 * a second option with the same value, which gave React duplicate keys and,
 * picked, showed the block and hid the very category chosen.
 */
export function resourceShelves(opts: {
  preCohort: boolean;
  categories: readonly string[];
}): ResourceShelfOption[] {
  const out: ResourceShelfOption[] = opts.preCohort
    ? [{ value: PRE_COHORT_SHELF, label: "Pre-cohort" }]
    : [];
  for (const c of opts.categories) {
    if (!out.some((o) => o.value === c)) out.push({ value: c, label: c });
  }
  return out;
}

/** Whether a regular row in `category` shows on `shelf` (null: every shelf). */
export function onShelf(category: string, shelf: string | null): boolean {
  return !shelf || category === shelf;
}

/**
 * Where the "Before day one" block (Before One worksheets and pre-cohort
 * resources) sits once the cohort has started.
 *
 * Folded away at the foot of the page only when it is finished business:
 * every published worksheet done. While any is unfinished it leads the page,
 * open, as it did before kickoff, because the links that send students here
 * after kickoff ("Work through Before One", a late enrollee's "Before One")
 * are about exactly that unfinished work. A search or shelf that matches in
 * it opens it wherever it is, so a result is never behind a click.
 */
export function beforeDayOneLayout(opts: {
  flowsTotal: number;
  flowsDone: number;
  filtering: boolean;
}): { leads: boolean; open: boolean } {
  const unfinished = opts.flowsDone < opts.flowsTotal;
  return { leads: unfinished, open: unfinished || opts.filtering };
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

/**
 * Resources opened on the pre-cohort shelf, for links that promise that
 * material ("Open pre-cohort resources" on kickoff day, a late enrollee's
 * "Before One"). After kickoff it opens the Before day one block wherever it
 * sits; before kickoff the page has no shelves, so it is the plain page.
 */
export const PRE_COHORT_RESOURCES_HREF = resourcesHref({ shelf: PRE_COHORT_SHELF });
