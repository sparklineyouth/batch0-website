"use client";
import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { DmPerson } from "@/lib/dm";
import { searchPeople } from "@/app/messages/actions";
import { Avatar, PersonLabel } from "@/components/messages/person";

/**
 * The directory: search anyone with an account and open a DM with them.
 *
 * Debounced, and every in-flight result is checked against the query it was
 * issued for before it lands — otherwise a fast typist watches results for
 * "ali" replace the ones for "alice" whenever the shorter query resolves last.
 */
export function PeopleSearch({
  onPick,
  onCancel,
  autoFocus = true,
  compact = false,
}: {
  onPick: (person: DmPerson) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DmPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef("");

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    latest.current = query;
    setLoading(true);
    // An empty query is a useful one here: it lists the directory so somebody
    // who doesn't know how a name is spelled still has a way in.
    const t = setTimeout(async () => {
      try {
        const people = await searchPeople(query);
        if (latest.current !== query) return;
        setResults(people);
        setError(null);
      } catch {
        if (latest.current !== query) return;
        setError("Couldn't load people. Try again.");
      } finally {
        if (latest.current === query) setLoading(false);
      }
    }, query ? 220 : 0);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search everyone at batch0…"
          aria-label="Search people"
          className="min-w-0 flex-1 bg-transparent text-base text-ink placeholder:text-ink-faint focus:outline-none md:text-sm"
        />
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="press flex h-6 w-6 items-center justify-center rounded-md text-ink-faint hover:bg-wash hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p role="alert" className="px-4 py-6 text-center text-xs text-red-400">
            {error}
          </p>
        )}
        {!error && loading && results.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-ink-faint">Searching…</p>
        )}
        {!error && !loading && results.length === 0 && (
          <p className="px-6 py-10 text-center text-sm text-ink-faint">
            {query ? `Nobody matching “${query}”.` : "No one to show."}
          </p>
        )}
        <ul className="divide-y divide-line">
          {results.map((person) => (
            <li key={person.id}>
              <button
                type="button"
                onClick={() => onPick(person)}
                className={`press flex w-full items-center gap-2.5 text-left hover:bg-wash ${
                  compact ? "px-3 py-2" : "px-4 py-2.5"
                }`}
              >
                <Avatar person={person} size="sm" />
                <PersonLabel person={person} className="min-w-0 flex-1 text-sm" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
