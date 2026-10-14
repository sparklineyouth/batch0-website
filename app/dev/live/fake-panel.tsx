"use client";
import { useEffect, useRef, useState } from "react";
import { SmilePlus } from "lucide-react";
import type { PanelTab, PanelUnread } from "@/components/live/room";

/**
 * In-memory stand-ins for the webinar side panel and reactions (the real ones
 * are WebinarPanel / ReactionsButton / ReactionsOverlay, rendered through the
 * same slots). Enough content to check layout, scrolling and badges.
 */

type Msg = { id: number; who: string; body: string };

const SEED: Msg[] = [
  { id: 1, who: "Ana (host)", body: "Welcome in. Slides in a minute." },
  { id: 2, who: "Jordan", body: "Hi from Toronto!" },
  { id: 3, who: "Priya", body: "Will this be recorded?" },
  { id: 4, who: "Ana (host)", body: "Yes, link goes out after." },
  { id: 5, who: "Sam", body: "Can you zoom in on the pricing table? It's a bit small on my laptop screen." },
  { id: 6, who: "Lee", body: "+1" },
];

const TABS: Record<PanelTab, string> = { chat: "Chat", qa: "Q&A", polls: "Polls", people: "People" };

export function FakePanel({
  tabs,
  tab,
  onTabChange,
  onUnread,
  open,
}: {
  tabs: readonly PanelTab[];
  tab: PanelTab;
  onTabChange: (t: PanelTab) => void;
  onUnread: (u: PanelUnread) => void;
  open: boolean;
}) {
  const [msgs, setMsgs] = useState<Msg[]>(SEED);
  const [draft, setDraft] = useState("");
  const [unreadChat, setUnreadChat] = useState(0);
  const seen = useRef(open && tab === "chat");
  useEffect(() => {
    seen.current = open && tab === "chat";
    if (seen.current) setUnreadChat(0);
  }, [open, tab]);
  // Someone says something every 7 seconds.
  useEffect(() => {
    let n = 100;
    const t = setInterval(() => {
      n += 1;
      setMsgs((m) => [...m, { id: n, who: "Jordan", body: `Message ${n - 100}` }].slice(-200));
      if (!seen.current) setUnreadChat((u) => u + 1);
    }, 7000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => onUnread({ chat: unreadChat, qa: 2, polls: 1 }), [unreadChat, onUnread]);

  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [msgs.length, tab]);

  return (
    <div className="flex h-full flex-col text-sm text-[#f4f4f5]" data-testid="fake-panel">
      <div className="flex shrink-0 gap-1 border-b border-[#26262b] p-1.5" role="tablist">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={t === tab}
            onClick={() => onTabChange(t)}
            className={`rounded px-2.5 py-1.5 text-xs ${t === tab ? "bg-[#26262b] text-[#fff]" : "text-[#a1a1aa] hover:text-[#fff]"}`}
          >
            {TABS[t]}
          </button>
        ))}
      </div>
      {tab === "chat" ? (
        <>
          <div ref={log} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {msgs.map((m) => (
              <div key={m.id}>
                <p className="text-xs text-[#a1a1aa]">{m.who}</p>
                <p className="break-words">{m.body}</p>
              </div>
            ))}
          </div>
          <form
            className="flex shrink-0 gap-2 border-t border-[#26262b] p-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              setMsgs((m) => [...m, { id: Date.now(), who: "You", body: draft.trim() }]);
              setDraft("");
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Message everyone"
              className="h-10 min-w-0 flex-1 rounded-md border !border-[#34343a] !bg-[#18181b] px-3 text-sm !text-[#f4f4f5] placeholder:text-[#71717a]"
              data-testid="fake-composer"
            />
            <button type="submit" className="h-10 rounded-md bg-[#FFBB00] px-3 text-sm font-semibold text-[#141414]">
              Send
            </button>
          </form>
        </>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-[#a1a1aa]">
          {TABS[tab]} (in-memory placeholder)
        </div>
      )}
    </div>
  );
}

const EMOJI = ["👏", "❤️", "😂", "🎉", "🤔"];

/** A shared bus between the fake button and overlay. */
const listeners = new Set<(e: string) => void>();

export function FakeReactionsButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="React"
        title="React"
        onClick={() => setOpen((o) => !o)}
        className="grid h-11 w-11 place-items-center rounded-md bg-[#26262b] text-[#f4f4f5] hover:bg-[#323238]"
        data-testid="fake-reactions"
      >
        <SmilePlus className="h-5 w-5" />
      </button>
      {open ? (
        <div className="absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 gap-1 rounded-md border border-[#34343a] bg-[#1b1b1f] p-1">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              className="rounded px-1.5 py-1 text-lg hover:bg-[#2a2a30]"
              onClick={() => {
                listeners.forEach((l) => l(e));
                setOpen(false);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FakeReactionsOverlay() {
  const [items, setItems] = useState<{ id: number; e: string }[]>([]);
  useEffect(() => {
    const on = (e: string) => {
      const id = Math.random();
      setItems((list) => [...list, { id, e }].slice(-8));
      setTimeout(() => setItems((list) => list.filter((x) => x.id !== id)), 2500);
    };
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, []);
  // Positioned like WS-C's ReactionsOverlay: it fills its container's height, bottom-right.
  return (
    <div className="pointer-events-none absolute bottom-0 right-0 top-0 flex w-40 flex-col-reverse items-end gap-1 overflow-hidden p-4 text-2xl sm:w-56">
      {items.map((x) => (
        <span key={x.id}>{x.e}</span>
      ))}
    </div>
  );
}
