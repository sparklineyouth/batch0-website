"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { fetchMembers, fetchPins, searchMessages } from "@/app/chat/actions";
import { plainText } from "@/lib/chat-format";
import { Avatar, RoleTag } from "./avatar";
import { stampLabel } from "./util";
import type { ChannelInfo, ChatMessage, ChatPerson, ChatViewerInfo, Panel } from "./types";

/** The right-hand panel: members, pins, or search. A sheet over the thread on a phone. */
export function SidePanel({
  panel,
  viewer,
  channel,
  people,
  online,
  channelNames,
  onClose,
  onJump,
  onMessagePerson,
  addPeople,
}: {
  panel: Exclude<Panel, null>;
  viewer: ChatViewerInfo;
  channel: ChannelInfo;
  people: Record<string, ChatPerson>;
  online: Set<string>;
  channelNames: Map<string, string>;
  onClose: () => void;
  onJump: (channelId: string, messageId: string) => void;
  onMessagePerson: (userId: string) => void;
  addPeople: (p: Record<string, ChatPerson>) => void;
}) {
  const title = panel === "members" ? "Members" : panel === "pins" ? "Pinned" : "Search";
  return (
    <aside
      className="fixed inset-0 z-40 flex flex-col bg-paper md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-line"
      aria-label={title}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3 pt-[calc(0.75rem+var(--safe-top))] md:pt-3">
        <h2 className="font-display text-2xl leading-none text-ink">{title}</h2>
        <button type="button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} className="rounded p-1 text-ink-faint hover:bg-wash hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {panel === "members" ? (
          <Members channel={channel} online={online} viewer={viewer} onMessagePerson={onMessagePerson} />
        ) : panel === "pins" ? (
          <Pins channel={channel} people={people} channelNames={channelNames} onJump={onJump} addPeople={addPeople} />
        ) : (
          <SearchPanel channel={channel} people={people} channelNames={channelNames} onJump={onJump} addPeople={addPeople} />
        )}
      </div>
    </aside>
  );
}

function Members({
  channel,
  online,
  viewer,
  onMessagePerson,
}: {
  channel: ChannelInfo;
  online: Set<string>;
  viewer: ChatViewerInfo;
  onMessagePerson: (userId: string) => void;
}) {
  const [list, setList] = useState<ChatPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setList(null);
    setError(null);
    fetchMembers(channel.id).then(setList).catch(() => setError("Couldn't load the member list."));
  }, [channel.id]);
  const groups = useMemo(() => {
    const all = list ?? [];
    const on = all.filter((p) => online.has(p.id));
    const off = all.filter((p) => !online.has(p.id));
    return [
      { title: `Online — ${on.length}`, people: on, live: true },
      { title: `Offline — ${off.length}`, people: off, live: false },
    ].filter((g) => g.people.length > 0);
  }, [list, online]);
  if (error) return <p className="p-4 text-xs text-red-600 dark:text-red-400">{error}</p>;
  if (!list) return <div className="flex justify-center p-6"><Loader2 className="h-4 w-4 animate-spin text-ink-faint" /></div>;
  return (
    <div className="p-2">
      {groups.map((g) => (
        <div key={g.title} className="mb-3">
          <p className="px-2 pb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">{g.title}</p>
          <ul>
            {g.people.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => p.id !== viewer.id && onMessagePerson(p.id)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-wash ${g.live ? "" : "opacity-60"}`}
                  title={p.id === viewer.id ? "You" : `Message ${p.name}`}
                >
                  <Avatar name={p.name} online={g.live} size={30} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {p.name}
                    {p.id === viewer.id ? <span className="ml-1 text-ink-faint">(you)</span> : null}
                  </span>
                  <RoleTag person={p} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {list.length >= 300 ? <p className="px-2 text-[11px] text-ink-faint">Showing the first 300 people.</p> : null}
    </div>
  );
}

function ResultList({
  messages,
  people,
  channelNames,
  onJump,
  showChannel,
}: {
  messages: ChatMessage[];
  people: Record<string, ChatPerson>;
  channelNames: Map<string, string>;
  onJump: (channelId: string, messageId: string) => void;
  showChannel: boolean;
}) {
  return (
    <ul className="divide-y divide-line">
      {messages.map((m) => {
        const who = m.senderId ? (people[m.senderId]?.name ?? "Someone") : "batch0";
        return (
          <li key={m.id}>
            <button type="button" onClick={() => onJump(m.channelId, m.id)} className="block w-full px-4 py-3 text-left hover:bg-wash">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-sm font-semibold text-ink">{who}</span>
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">{stampLabel(m.createdAt)}</span>
              </span>
              {showChannel && channelNames.get(m.channelId) ? (
                <span className="block font-mono text-[10px] text-ink-faint">#{channelNames.get(m.channelId)}</span>
              ) : null}
              <span className="mt-0.5 line-clamp-3 block text-sm text-ink-soft">
                {plainText(m.body || "[attachment]", (id) => people[id]?.name, (id) => channelNames.get(id) ?? null, 300)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Pins({
  channel,
  people,
  channelNames,
  onJump,
  addPeople,
}: {
  channel: ChannelInfo;
  people: Record<string, ChatPerson>;
  channelNames: Map<string, string>;
  onJump: (channelId: string, messageId: string) => void;
  addPeople: (p: Record<string, ChatPerson>) => void;
}) {
  const [list, setList] = useState<ChatMessage[] | null>(null);
  useEffect(() => {
    setList(null);
    fetchPins(channel.id)
      .then((r) => {
        addPeople(r.people);
        setList(r.messages);
      })
      .catch(() => setList([]));
  }, [channel.id, addPeople]);
  if (!list) return <div className="flex justify-center p-6"><Loader2 className="h-4 w-4 animate-spin text-ink-faint" /></div>;
  if (list.length === 0) {
    return (
      <p className="p-4 text-sm text-ink-soft">
        Nothing pinned yet.{" "}
        {channel.canPin ? "Pin a message from its ••• menu and it'll live here." : "When the team pins something important, it lives here."}
      </p>
    );
  }
  return <ResultList messages={list} people={people} channelNames={channelNames} onJump={onJump} showChannel={false} />;
}

function SearchPanel({
  channel,
  people,
  channelNames,
  onJump,
  addPeople,
}: {
  channel: ChannelInfo;
  people: Record<string, ChatPerson>;
  channelNames: Map<string, string>;
  onJump: (channelId: string, messageId: string) => void;
  addPeople: (p: Record<string, ChatPerson>) => void;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"here" | "all">("here");
  const [results, setResults] = useState<ChatMessage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults(null);
      return;
    }
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await searchMessages(query, scope === "here" ? channel.id : null);
        if (n !== seq.current) return;
        addPeople(res.people);
        setResults(res.messages);
        setError(null);
      } catch {
        if (n === seq.current) setError("Search didn't work. Try again in a moment.");
      } finally {
        if (n === seq.current) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, scope, channel.id, addPeople]);
  return (
    <div>
      <div className="border-b border-line p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search messages"
            aria-label="Search messages"
            className="w-full rounded-md border border-line bg-paper py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-ink/40 focus:outline-none"
          />
        </div>
        <div className="mt-2 flex gap-1 text-xs">
          {(["here", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              aria-pressed={scope === s}
              className={`rounded-md px-2 py-1 ${scope === s ? "bg-wash text-ink" : "text-ink-faint hover:text-ink"}`}
            >
              {s === "here" ? (channel.kind === "channel" ? `#${channel.label}` : "This conversation") : "Everywhere"}
            </button>
          ))}
        </div>
      </div>
      {error ? <p className="p-4 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      {loading && !results ? <div className="flex justify-center p-6"><Loader2 className="h-4 w-4 animate-spin text-ink-faint" /></div> : null}
      {results && results.length === 0 ? <p className="p-4 text-sm text-ink-soft">No messages match.</p> : null}
      {results && results.length > 0 ? (
        <ResultList messages={results} people={people} channelNames={channelNames} onJump={onJump} showChannel={scope === "all"} />
      ) : null}
      {!results && !loading ? <p className="p-4 text-xs text-ink-faint">Type at least two characters.</p> : null}
    </div>
  );
}
