"use client";
import { useEffect, useState, type ReactNode } from "react";
import { listAudience } from "@/app/live/actions";
import type { LivePeer } from "@/lib/live-rooms";
import { Chip, Empty } from "./ui";

const PEOPLE_POLL_MS = 10_000;

/**
 * Who is here — hosts only. Staff see the audience by name; a guest speaker
 * is told how many (listAudience withholds viewer names from them, server
 * side). Read only while this tab is open.
 */
export function PeopleTab({
  eventId,
  selfId,
  selfName,
  showNames,
  live,
  audienceCount,
}: {
  eventId: string;
  selfId: string;
  selfName: string;
  showNames: boolean;
  live: boolean;
  audienceCount: number | null;
}) {
  const [peers, setPeers] = useState<LivePeer[] | null>(null);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = await listAudience("event", eventId);
        if (!cancelled) setPeers(next);
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

  const others = (peers ?? []).filter((p) => p.peerId !== selfId);
  const hosts = others.filter((p) => p.role === "host");
  const viewers = others.filter((p) => p.role !== "host");
  const watching = audienceCount ?? viewers.length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-2 text-sm">
      <Section title="Hosts">
        <ul>
          <Person name={selfName} note="You" />
          {hosts.map((h) => (
            <Person key={h.peerId} name={h.name || "Host"} />
          ))}
        </ul>
      </Section>
      <Section title={`Watching · ${watching}`}>
        {peers === null ? (
          <Empty>{live ? "Loading…" : "Join to see who's here."}</Empty>
        ) : !showNames ? null : viewers.length === 0 ? (
          <Empty>Nobody yet.</Empty>
        ) : (
          <ul>
            {viewers.map((v) => (
              <Person key={v.peerId} name={v.name || "Student"} />
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
