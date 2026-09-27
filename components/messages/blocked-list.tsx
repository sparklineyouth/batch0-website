"use client";
import { useCallback, useEffect, useState } from "react";
import { Ban, ChevronDown } from "lucide-react";
import type { DmPerson } from "@/lib/dm";
import { fetchBlockedPeople, unblockPerson } from "@/app/messages/actions";
import { Avatar } from "@/components/messages/person";

/**
 * The viewer's block list, collapsed by default.
 *
 * It exists because a block doesn't need a conversation: you can block someone
 * straight out of the directory, and blocked people are filtered out of search
 * — so without this there'd be no way back. Unblocking from inside a thread
 * only helps when a thread exists.
 *
 * Loads on first expand rather than on mount; most people will never open it.
 */
export function BlockedList() {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<DmPerson[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPeople(await fetchBlockedPeople());
    } catch {
      setPeople([]);
    }
  }, []);

  useEffect(() => {
    if (open && people === null) load();
  }, [open, people, load]);

  async function unblock(id: string) {
    setBusyId(id);
    const res = await unblockPerson(id);
    setBusyId(null);
    if (res.ok) setPeople((prev) => (prev ?? []).filter((p) => p.id !== id));
  }

  return (
    <div className="border-t border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="press flex w-full items-center justify-between px-4 py-2.5 text-left text-xs text-ink-faint hover:bg-wash hover:text-ink-soft"
      >
        <span className="inline-flex items-center gap-1.5">
          <Ban className="h-3 w-3" />
          Blocked
          {people && people.length > 0 && (
            <span className="text-ink-faint">({people.length})</span>
          )}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="pb-2">
          {people === null ? (
            <p className="px-4 py-2 text-xs text-ink-faint">Loading…</p>
          ) : people.length === 0 ? (
            <p className="px-4 py-2 text-xs text-ink-faint">
              You haven&apos;t blocked anyone.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {people.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2 px-4 py-1.5 text-xs"
                >
                  <Avatar person={p} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-ink-soft">{p.name}</span>
                  <button
                    type="button"
                    onClick={() => unblock(p.id)}
                    disabled={busyId === p.id}
                    className="press shrink-0 font-medium text-phosphor-ink hover:opacity-80 disabled:opacity-50"
                  >
                    Unblock
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
