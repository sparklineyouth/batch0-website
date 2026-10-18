"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MessagesSquare, Search, X } from "lucide-react";
import { searchMessages } from "@/app/chat/actions";
import { plainText } from "@/lib/chat-format";
import { Avatar, RoleTag } from "./avatar";
import { chatApi, READ_FAILED, tracked } from "./api";
import { senderName, sinceLabel, stampLabel, unansweredLabel } from "./util";
import { AboutLink } from "./message-list";
import { ThreadPanel } from "./thread-panel";
import type { ChannelInfo, ChatMessage, ChatPerson, ChatViewerInfo, Panel } from "./types";

/** What the thread pane needs from ChatApp (0110), passed straight through. */
export type ThreadPaneProps = Omit<
  React.ComponentProps<typeof ThreadPanel>,
  "viewer" | "channel" | "people" | "online" | "channelNames" | "onClose" | "onMessagePerson" | "addPeople" | "blocked" | "onUnanswered"
>;

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Below lg the panel covers the conversation; from lg up it sits beside it. */
function useCovers(): boolean {
  const [covers, setCovers] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setCovers(!mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return covers;
}

/**
 * The right-hand panel: members, pins, or search. A full-screen sheet on a
 * phone and a drawer over the conversation on a tablet — a dialog, then:
 * focus moves in, Tab stays in, Escape closes it — and a column beside the
 * conversation from lg up. Closing it puts focus back on the header button
 * that opened it.
 */
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
  thread = null,
  onOpenThread,
  blocked = [],
  onUnanswered,
}: {
  panel: Exclude<Panel, null>;
  viewer: ChatViewerInfo;
  channel: ChannelInfo;
  people: Record<string, ChatPerson>;
  online: Set<string>;
  channelNames: Map<string, string>;
  onClose: () => void;
  /** A search hit or pin: open the channel around it — or, for a thread reply, its thread. */
  onJump: (channelId: string, messageId: string, threadRootId?: string | null) => void;
  onMessagePerson: (userId: string) => void;
  addPeople: (p: Record<string, ChatPerson>) => void;
  /** The thread pane's wiring, when `panel` is "thread". */
  thread?: ThreadPaneProps | null;
  /** #help's Unanswered list: open a question's thread. */
  onOpenThread?: (rootId: string) => void;
  /** People this viewer blocked: their messages are collapsed here as in the feed. */
  blocked?: readonly string[];
  /** #help's open-question count, as a list or a settled question just read it: the header's badge. */
  onUnanswered?: (channelId: string, n: number) => void;
}) {
  const title =
    panel === "members"
      ? "Members"
      : panel === "pins"
        ? "Pinned"
        : panel === "thread"
          ? "Thread"
          : panel === "unanswered"
            ? "Unanswered"
            : "Search";
  const threadRoot = panel === "thread" ? (thread?.rootId ?? null) : null;
  const covers = useCovers();
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Focus goes back to the header button for this panel when it closes (or
  // switches to another panel), if it was inside the panel.
  useEffect(() => {
    const el = ref.current;
    const had = () => !!el && el.contains(document.activeElement);
    let inside = had();
    const track = () => (inside = had());
    document.addEventListener("focusin", track);
    return () => {
      document.removeEventListener("focusin", track);
      // After the panel is really gone (not a StrictMode re-run), and only if
      // focus went down with it.
      setTimeout(() => {
        const lost = !document.activeElement || document.activeElement === document.body;
        if (el && !el.isConnected && inside && lost) {
          // A thread goes back to what opened it: its "N replies", or the message.
          const opener = threadRoot
            ? (document.querySelector<HTMLElement>(`[data-thread-opener="${threadRoot}"]`) ??
              document.querySelector<HTMLElement>(`[data-mid="${threadRoot}"]`))
            : document.querySelector<HTMLElement>(`[data-panel-toggle="${panel}"]`);
          opener?.focus({ preventScroll: true });
        }
      }, 0);
    };
  }, [panel, threadRoot]);

  // Covering the conversation: behave as a dialog.
  useEffect(() => {
    const el = ref.current;
    if (!covers || !el) return;
    if (!el.contains(document.activeElement)) {
      (el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      // A dialog opened from inside the panel owns the keyboard.
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-side-panel])')) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && at <= 0) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && (at === -1 || at === items.length - 1)) {
        e.preventDefault();
        items[0].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [covers, panel]);

  return (
    <>
      {covers ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={onClose}
          className="fixed inset-0 z-30 hidden bg-ink/20 md:block"
        />
      ) : null}
    <aside
      ref={ref}
      className={`fixed inset-0 z-40 flex flex-col bg-paper md:inset-y-0 md:left-auto md:right-0 md:border-l md:border-line md:shadow-[0_0_40px_-10px_rgba(20,20,20,0.25)] lg:static lg:z-auto lg:shrink-0 lg:shadow-none ${panel === "thread" ? "md:w-96" : "md:w-80"}`}
      aria-label={title}
      role={covers ? "dialog" : undefined}
      aria-modal={covers ? true : undefined}
      data-side-panel
    >
      {panel === "thread" && thread ? (
        // The thread is a pane of its own: its header (Back on a phone,
        // Follow, Ask the team), its replies and its composer.
        <ThreadPanel
          {...thread}
          viewer={viewer}
          channel={channel}
          people={people}
          online={online}
          channelNames={channelNames}
          blocked={blocked}
          onClose={onClose}
          onMessagePerson={onMessagePerson}
          addPeople={addPeople}
          onUnanswered={onUnanswered}
        />
      ) : (
        <>
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
            ) : panel === "unanswered" ? (
              <Unanswered
                channel={channel}
                people={people}
                channelNames={channelNames}
                addPeople={addPeople}
                onOpenThread={onOpenThread}
                blocked={blocked}
                onTotal={(n) => onUnanswered?.(channel.id, n)}
              />
            ) : (
              <SearchPanel channel={channel} people={people} channelNames={channelNames} onJump={onJump} addPeople={addPeople} />
            )}
          </div>
        </>
      )}
    </aside>
    </>
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
    let live = true;
    setList(null);
    setError(null);
    chatApi
      .members(channel.id)
      .then((l) => live && setList(l))
      .catch(() => live && setError("Couldn't load the member list. Close this and try again."));
    return () => {
      live = false;
    };
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
            {g.people.map((p) => {
              const row = (
                <>
                  <Avatar name={p.name} online={g.live} size={30} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {p.name}
                    {p.id === viewer.id ? <span className="ml-1 text-ink-faint">(you)</span> : null}
                  </span>
                  <RoleTag person={p} />
                </>
              );
              return (
                <li key={p.id}>
                  {p.id === viewer.id ? (
                    <div className={`flex w-full items-center gap-2.5 px-2 py-1.5 ${g.live ? "" : "opacity-60"}`}>{row}</div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onMessagePerson(p.id)}
                      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-wash ${g.live ? "" : "opacity-60"}`}
                      title={`Message ${p.name}`}
                    >
                      {row}
                    </button>
                  )}
                </li>
              );
            })}
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
  onJump: (channelId: string, messageId: string, threadRootId?: string | null) => void;
  showChannel: boolean;
}) {
  return (
    <ul className="divide-y divide-line">
      {messages.map((m) => {
        const who = senderName(m, people);
        return (
          <li key={m.id}>
            <button type="button" onClick={() => onJump(m.channelId, m.id, m.threadRootId ?? null)} className="block w-full px-4 py-3 text-left hover:bg-wash">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 truncate text-sm font-semibold text-ink">{who}</span>
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">{stampLabel(m.createdAt)}</span>
              </span>
              {showChannel && channelNames.get(m.channelId) ? (
                <span className="block font-mono text-[10px] text-ink-faint">#{channelNames.get(m.channelId)}</span>
              ) : null}
              {m.threadRootId ? <span className="block font-mono text-[10px] text-ink-faint">In a thread</span> : null}
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
  onJump: (channelId: string, messageId: string, threadRootId?: string | null) => void;
  addPeople: (p: Record<string, ChatPerson>) => void;
}) {
  const [list, setList] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setList(null);
    setError(null);
    chatApi
      .pins(channel.id)
      .then((r) => {
        if (!live) return;
        addPeople(r.people);
        setList(r.messages);
      })
      .catch(() => live && setError(READ_FAILED));
    return () => {
      live = false;
    };
  }, [channel.id, addPeople]);
  if (error) return <p className="p-4 text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>;
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
  onJump: (channelId: string, messageId: string, threadRootId?: string | null) => void;
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
      // Drop any search still in flight, and its spinner with it.
      seq.current++;
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await tracked(searchMessages(query, scope === "here" ? channel.id : null));
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
            data-autofocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search messages"
            aria-label="Search messages"
            className="w-full rounded-md border border-line bg-paper py-2 pl-9 pr-3 text-base text-ink placeholder:text-ink-faint focus:border-ink/40 focus:outline-none md:text-sm"
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
      {error ? <p className="p-4 text-xs text-red-600 dark:text-red-400" role="alert">{error}</p> : null}
      {loading && !results ? <div className="flex justify-center p-6"><Loader2 className="h-4 w-4 animate-spin text-ink-faint" /></div> : null}
      {results && results.length === 0 ? <p className="p-4 text-sm text-ink-soft">No messages match.</p> : null}
      {results && results.length > 0 ? (
        <ResultList messages={results} people={people} channelNames={channelNames} onJump={onJump} showChannel={scope === "all"} />
      ) : null}
      {!results && !loading ? <p className="p-4 text-xs text-ink-faint">Type at least two characters.</p> : null}
    </div>
  );
}

/**
 * #help's Unanswered list (0110): its open questions, the ones waiting
 * longest first — the questions' own messages, as anyone in #help reads
 * them, except that one from someone the viewer blocked says so instead of
 * what it says (the thread's own copy is collapsed with "show", as in the
 * feed). Picking one opens its thread. The count it reads is the header
 * badge's too (`onTotal`).
 */
function Unanswered({
  channel,
  people,
  channelNames,
  addPeople,
  onOpenThread,
  blocked,
  onTotal,
}: {
  channel: ChannelInfo;
  people: Record<string, ChatPerson>;
  channelNames: Map<string, string>;
  addPeople: (p: Record<string, ChatPerson>) => void;
  onOpenThread?: (rootId: string) => void;
  blocked: readonly string[];
  onTotal: (n: number) => void;
}) {
  const [list, setList] = useState<ChatMessage[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const totalRef = useRef(onTotal);
  totalRef.current = onTotal;
  useEffect(() => {
    let live = true;
    setList(null);
    setError(null);
    chatApi
      .unanswered(channel.id)
      .then((r) => {
        if (!live) return;
        addPeople(r.people);
        setList(r.questions);
        setTotal(r.total);
        totalRef.current(r.total);
      })
      .catch(() => live && setError(READ_FAILED));
    return () => {
      live = false;
    };
  }, [channel.id, addPeople]);
  if (error) return <p className="p-4 text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>;
  if (!list) return <div className="flex justify-center p-6"><Loader2 className="h-4 w-4 animate-spin text-ink-faint" /></div>;
  if (list.length === 0) {
    return <p className="p-4 text-sm text-ink-soft">No open questions in #{channel.label}. When someone asks one, it waits here until it&apos;s answered.</p>;
  }
  return (
    <div>
      <p className="border-b border-line px-4 py-2 text-xs text-ink-faint">
        {total === 1 ? "1 open question" : `${total} open questions`}, waiting longest first.
        {total > list.length ? ` Showing ${list.length}.` : ""}
      </p>
      <ul className="divide-y divide-line">
        {list.map((m) => {
          const replies = m.thread?.replyCount ?? 0;
          const hidden = !!m.senderId && blocked.includes(m.senderId);
          const who = hidden ? "Someone you blocked" : senderName(m, people);
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onOpenThread?.(m.id)}
                data-thread-opener={m.id}
                className="block w-full px-4 py-3 text-left hover:bg-wash"
                aria-label={unansweredLabel(who, m.createdAt, replies)}
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate text-sm font-semibold text-ink">{who}</span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-faint">{sinceLabel(m.createdAt)}</span>
                </span>
                {hidden ? (
                  <span className="mt-0.5 block text-xs italic text-ink-faint">Question from someone you blocked</span>
                ) : (
                  <span className="mt-0.5 line-clamp-3 block text-sm text-ink-soft">
                    {plainText(m.body || "[attachment]", (id) => people[id]?.name, (id) => channelNames.get(id) ?? null, 300)}
                  </span>
                )}
                <span className={`mt-1 inline-flex items-center gap-1 text-[11px] ${replies === 0 ? "font-medium text-amber-800 dark:text-amber-200" : "text-ink-faint"}`}>
                  <MessagesSquare className="h-3 w-3" aria-hidden />
                  {replies === 0 ? "No replies yet" : `${replies} ${replies === 1 ? "reply" : "replies"}, not answered yet`}
                </span>
              </button>
              {m.thread?.about ? (
                <div className="px-4 pb-3">
                  <AboutLink about={m.thread.about} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
