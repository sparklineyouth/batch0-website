"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, X, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";

/**
 * Search-as-you-type box for the People directory.
 *
 * The actual filtering is server-side (a DB `ilike` in page.tsx) so it spans
 * every account, not just the rows already rendered. This component only owns
 * the input and debounced URL updates: typing rewrites `?q=` after a short
 * pause, and the server re-renders the list. The role tab is preserved so a
 * search narrows within the current role rather than resetting it.
 */
export function PeopleSearch({
  initialQuery,
  role,
}: {
  /** Current `?q=` value, echoed back so the box survives a reload/nav. */
  initialQuery: string;
  /** Active role tab slug ("all" or a role slug), preserved on every search. */
  role: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const [pending, start] = useTransition();

  // Keep the latest role without making it a dependency of the debounce effect:
  // clicking a role tab must NOT trigger a redundant search navigation.
  const roleRef = useRef(role);
  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  // Debounce URL updates so we navigate once the admin pauses, not per keystroke.
  // Skip the initial mount so simply landing on the page doesn't re-navigate.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const t = setTimeout(() => {
      const params = new URLSearchParams();
      if (roleRef.current && roleRef.current !== "all") {
        params.set("role", roleRef.current);
      }
      const q = value.trim();
      if (q) params.set("q", q);
      const qs = params.toString();
      start(() => router.push(qs ? `/admin/students?${qs}` : "/admin/students"));
    }, 300);
    return () => clearTimeout(t);
  }, [value, router]);

  return (
    <div className="relative max-w-md">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search people by name or email…"
        aria-label="Search people by name or email"
        autoComplete="off"
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
