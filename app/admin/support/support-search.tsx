"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, X, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SEARCH_QUERY_MAX } from "@/lib/support-access";

/**
 * Search-as-you-type box for the support queue — the People search
 * (app/admin/students/people-search.tsx) with the queue's own URL.
 *
 * The matching is server-side (listTicketsForStaff's `search`: a reference
 * typed in full lands on exactly that request, anything else is a "contains"
 * over reference, email, name and subject), so it spans every request, not
 * just the rows on screen. This only owns the input and the debounced `?q=`.
 * The rest of the URL — the view tab, category, priority and owner filters —
 * rides along, so a search narrows what's on screen rather than resetting it.
 * The page is the one thing that doesn't: the page passes `params` without
 * it, because page 3 of a different set of results is nobody's "where I was".
 *
 * replace, not push: each pause in typing is not a page anyone wants Back to
 * step through. Back from a request still lands on the search that found it.
 */
export function SupportSearch({
  initialQuery,
  params,
}: {
  /** Current `?q=` (trimmed, as the page read it), echoed back so the box survives a reload. */
  initialQuery: string;
  /** Every other query param of the current view, preserved on each search. */
  params: Record<string, string>;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const [pending, start] = useTransition();

  // The latest filters, without making them a dependency of the debounce:
  // clicking a view tab must NOT fire a redundant search navigation.
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  // The query the URL holds as far as this box knows: the one it last asked
  // for, or the one the page last rendered with. Typing navigates only when
  // it would change that — which is also what stops landing on the page from
  // re-navigating.
  const shown = useRef(initialQuery);

  // The URL's ?q= can change without the box: Back, or the empty state's
  // "Clear search". Follow it, or the box keeps saying "smith" over a list
  // that isn't filtered. The echo of the box's own navigation is ignored —
  // it arrives while the person may already have typed further.
  useEffect(() => {
    if (initialQuery === shown.current) return;
    shown.current = initialQuery;
    setValue(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    const q = value.trim();
    if (q === shown.current) return;
    const t = setTimeout(() => {
      shown.current = q;
      const next = new URLSearchParams(paramsRef.current);
      if (q) next.set("q", q);
      else next.delete("q");
      const qs = next.toString();
      start(() =>
        router.replace(qs ? `/admin/support?${qs}` : "/admin/support", { scroll: false }),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [value, router]);

  return (
    <div className="relative w-full max-w-md">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search by reference, email, name or subject…"
        aria-label="Search requests by reference, email, name or subject"
        autoComplete="off"
        maxLength={SEARCH_QUERY_MAX}
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
  );
}
