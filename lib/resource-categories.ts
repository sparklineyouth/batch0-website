// ---------------------------------------------------------------------------
// Resource categories — shared, pure logic.
//
// `resources.category` is free text in the schema; this is the list the admin
// form offers and the order the student page shows them in. The four sprint
// categories ("week 1 · validate" …) came in with the Week 1 field guide
// (migration 0073): filing a reading under its sprint puts it under its own
// heading on /dashboard/resources instead of in the general "readings" pile.
//
// Imported by a server page and a client form — keep it dependency-free.
// ---------------------------------------------------------------------------

/** The four taught sprints, in program order. Matches components/curriculum. */
export const SPRINT_CATEGORIES = [
  "week 1 · validate",
  "week 2 · build",
  "week 3 · market",
  "week 4 · pitch",
] as const;

/** Everything the admin form offers. Sprints first, then the generic shelves. */
export const RESOURCE_CATEGORIES: readonly string[] = [
  ...SPRINT_CATEGORIES,
  "general",
  "templates",
  "decks",
  "guides",
  "readings",
  "tools",
];

const WEEK_RE = /^week\s+(\d+)\b/i;

/**
 * Display order for category headings on the resources page.
 *
 * Sprint categories come first, in week order, because "what do I read this
 * week" is the question a student arrives with; the generic shelves follow
 * alphabetically, which is what the page always did. Any unrecognised
 * category (an admin can type anything) sorts with the generic shelves.
 */
export function sortCategories(categories: Iterable<string>): string[] {
  const weekOf = (c: string): number | null => {
    const m = WEEK_RE.exec(c.trim());
    return m ? Number(m[1]) : null;
  };
  return Array.from(new Set(categories)).sort((a, b) => {
    const wa = weekOf(a);
    const wb = weekOf(b);
    if (wa !== null && wb !== null) return wa - wb || a.localeCompare(b);
    if (wa !== null) return -1;
    if (wb !== null) return 1;
    return a.localeCompare(b);
  });
}
