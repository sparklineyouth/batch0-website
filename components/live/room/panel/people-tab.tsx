"use client";
import { useEffect, useState, type ReactNode } from "react";
import { PEOPLE_POLL_MS, type PanelPeople } from "@/lib/webinar-panel";
import { readPeople } from "./panel-api";
import { Chip, Empty } from "./ui";

/**
 * Who is here — hosts only. Staff see the audience by name; a guest speaker
 * is told how many (the server withholds viewer names from them). Read from
 * GET /api/live/panel only while this tab is open, so it never queues a send.
 */
export function PeopleTab({
  eventId,
  selfName,
  live,
  audienceCount,
}: {
  eventId: string;
  selfName: string;
  live: boolean;
  audienceCount: number | null;
}) {
  const [people, setPeople] = useState<PanelPeople | null>(null);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const load = async () => {
      if (document.hidden) return;
      try {
        const next = await readPeople(eventId);
        if (!cancelled && next) setPeople(next);
      } catch {
        // Keep the last answer; the next tick retries.
      }
    };
    void load();
    const timer = setInterval(() => void load(), PEOPLE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [eventId, live]);

  const watching = audienceCount ?? people?.watching ?? 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-2 text-sm">
      <Section title="Hosts">
        <ul>
          <Person name={selfName} note="You" />
          {(people?.hosts ?? []).map((name, i) => (
            <Person key={`${i}:${name}`} name={name} />
          ))}
        </ul>
      </Section>
      <Section title={`Watching · ${watching}`}>
        {people === null ? (
          <Empty>{live ? "Loading…" : "Join to see who's here."}</Empty>
        ) : people.viewers === null ? null : people.viewers.length === 0 ? (
          <Empty>Nobody yet.</Empty>
        ) : (
          <ul>
            {people.viewers.map((name, i) => (
              <Person key={`${i}:${name}`} name={name} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-3">
      <h3 className="px-3 pb-1 text-xs font-medium text-ink-faint">{title}</h3>
      {children}
    </section>
  );
}

function Person({ name, note }: { name: string; note?: string }) {
  return (
    <li className="flex items-center gap-2 px-3 py-1.5">
      <span
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink/10 text-xs font-semibold text-ink-soft"
      >
        {name.trim().charAt(0).toUpperCase() || "?"}
      </span>
      <span className="min-w-0 truncate text-ink">{name}</span>
      {note && <Chip>{note}</Chip>}
    </li>
  );
}
