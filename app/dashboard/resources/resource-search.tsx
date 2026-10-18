"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, X, Loader2 } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { RESOURCE_QUERY_MAX, parseResourceQuery, resourcesHref } from "@/lib/resource-search";

/**
 * The resources page's search row: a search-as-you-type box and a shelf
 * picker. The Support queue's search (app/admin/support/support-search.tsx)
 * with this page's URL.
 *
 * The matching is server-side (page.tsx narrows the rows RLS already let the
 * student read), so this only owns the controls and the URL. Typing rewrites
 * `?q=` after a pause; picking a shelf navigates at once. replace, not push:
 * each pause in typing is not a page anyone wants Back to step through.
 *
 * It is a real GET form underneath, so Enter (or a page that never hydrated)
 * still searches.
 */
export function ResourceSearch({
  initialQuery,
  shelf,
  shelves,
}: {
  /** Current `?q=`, as the page read it, so the box survives a reload. */
  initialQuery: string;
  /** Current `?shelf=`, or null for every shelf. */
  shelf: string | null;
  /** The shelves the page has, in page order. Under two, there is no picker. */
  shelves: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const [picked, setPicked] = useState(shelf ?? "");
  const [pending, start] = useTransition();

  // The latest shelf, without making it a dependency of the debounce: picking
  // a shelf must not also fire a second, redundant search navigation.
  const shelfRef = useRef(picked);
  useEffect(() => {
    shelfRef.current = picked;
  }, [picked]);

  // The query the URL holds as far as this box knows. Typing navigates only
  // when it would change that, which is also what stops landing on the page
  // from re-navigating.
  //
  // Always in the page's own form (parseResourceQuery: trimmed, inner spaces
  // collapsed). Kept as a bare trim, "pitch  deck" here met "pitch deck" from
  // the page, read as the URL moving under the box, and overwrote whatever
  // had been typed while that navigation was in flight.
  const shown = useRef(initialQuery);

  // The URL can change without the box (Back, or the "Clear" link): follow it.
  useEffect(() => {
    if (initialQuery === shown.current) return;
    shown.current = initialQuery;
    setValue(initialQuery);
  }, [initialQuery]);
  useEffect(() => {
    setPicked(shelf ?? "");
  }, [shelf]);

  const go = (q: string, nextShelf: string) => {
    shown.current = q;
    start(() => router.replace(resourcesHref({ q, shelf: nextShelf || null }), { scroll: false }));
  };

  useEffect(() => {
    const q = parseResourceQuery(value);
    if (q === shown.current) return;
    const t = setTimeout(() => {
      shown.current = q;
      start(() =>
        router.replace(resourcesHref({ q, shelf: shelfRef.current || null }), { scroll: false }),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [value, router]);

  return (
    <form
      action="/dashboard/resources"
      method="get"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        go(parseResourceQuery(value), picked);
      }}
      className="flex flex-col gap-2 sm:flex-row"
    >
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <Input
          type="search"
          name="q"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search resources…"
          aria-label="Search resources by title, description or category"
          autoComplete="off"
          enterKeyHint="search"
          maxLength={RESOURCE_QUERY_MAX}
          className="pl-9 pr-9"
        />
        {pending ? (
          <Loader2
            className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-ink-faint"
            aria-hidden
          />
        ) : value ? (
          <button
            type="button"
            onClick={() => setValue("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-faint hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      {shelves.length > 1 && (
        <Select
          name="shelf"
          value={picked}
          onChange={(e) => {
            setPicked(e.target.value);
            go(parseResourceQuery(value), e.target.value);
          }}
          aria-label="Show one shelf"
          className="capitalize sm:w-56"
        >
          <option value="">All shelves</option>
          {shelves.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      )}
    </form>
  );
}
