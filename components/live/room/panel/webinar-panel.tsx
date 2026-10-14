"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AlertTriangle, X } from "lucide-react";
import {
  audienceCanSeeEachOther,
  messagesNeedApproval,
  type ChatMessage,
  type RoomQuestion,
  type WebinarPoll,
} from "@/lib/webinars";
import {
  chooseOption,
  hideRow,
  panelTabs,
  unseenCount,
  unseenOpenPolls,
  voteOn,
  type PanelRole,
  type PanelTab,
  type WebinarPanelInitial,
} from "@/lib/webinar-panel";
import { panelWrite } from "./panel-api";
import { usePanelFeed } from "./use-panel-feed";
import { useOutbox } from "./use-outbox";
import { ChatTab } from "./chat-tab";
import { QaTab } from "./qa-tab";
import { PollsTab, type PollDraft, type PollInput } from "./polls-tab";
import { PeopleTab } from "./people-tab";

export type { WebinarPanelInitial } from "@/lib/webinar-panel";

export type UnreadCounts = { chat: number; qa: number; polls: number };

const TAB_LABEL: Record<PanelTab, string> = {
  chat: "Chat",
  qa: "Q&A",
  polls: "Polls",
  people: "People",
};

/**
 * The webinar side panel: Chat · Q&A · Polls · People (hosts).
 *
 * Fills its container; the room owns the frame (column or bottom sheet) and
 * the open/closed state. Keep it mounted while hidden — it keeps listening,
 * and unread counts come from what was actually on screen (a hidden panel
 * marks nothing seen).
 */
export function WebinarPanel({
  eventId,
  role,
  selfName,
  roomTopic,
  moderationTopic,
  live,
  ended,
  tab,
  onTabChange,
  audienceCount,
  onUnread,
  initial,
  tone = "call",
}: {
  eventId: string;
  role: PanelRole;
  /** Part of the room contract; the server already leaves the reader out of every list. */
  selfId: string;
  selfName: string;
  roomTopic: string | null;
  moderationTopic: string | null;
  /** Session live: enables realtime and the resync. */
  live: boolean;
  ended: boolean;
  tab: PanelTab;
  onTabChange(tab: PanelTab): void;
  audienceCount: number | null;
  onUnread?(counts: UnreadCounts): void;
  initial: WebinarPanelInitial;
  /** "call": the dark room surface (default). "page": follow the page theme. */
  tone?: "call" | "page";
}) {
  const feed = usePanelFeed({ eventId, initial, roomTopic, moderationTopic, live });
  const isHost = role !== "viewer";
  const chatOn = audienceCanSeeEachOther(feed.audienceMode);
  const needsApproval = messagesNeedApproval(feed.audienceMode);
  // After End the audience reads; hosts keep everything for a closing word.
  const closed = ended && !isHost;

  const tabs = panelTabs(role, chatOn);
  const active = tabs.includes(tab) ? tab : tabs[0];
  useEffect(() => {
    if (active !== tab) onTabChange(active);
  }, [active, tab, onTabChange]);

  // --- writes --------------------------------------------------------------

  const { write, setChatO, setQaO, setPollO, insertChat, insertQuestion } = feed;

  const chatOutbox = useOutbox<ChatMessage>({
    send: (id, body) => panelWrite(eventId, { op: "chat.send", id, body }),
    onSent: insertChat,
  });
  const askOutbox = useOutbox<RoomQuestion>({
    send: (id, body) => panelWrite(eventId, { op: "qa.ask", id, body }),
    onSent: insertQuestion,
  });

  // Unsent text lives here, not in the tabs: switching tabs keeps it.
  const [chatDraft, setChatDraft] = useState("");
  const [qaDraft, setQaDraft] = useState("");
  const [pollDraft, setPollDraft] = useState<PollDraft | null>(null);

  const removeMessage = useCallback(
    (m: ChatMessage) =>
      void write(setChatO, [[m.id, hideRow]], () =>
        panelWrite(
          eventId,
          m.mine
            ? { op: "chat.delete", id: m.id }
            : { op: "chat.moderate", id: m.id, action: "remove" },
        ),
      ),
    [eventId, write, setChatO],
  );
  const approveMessage = useCallback(
    (id: string) =>
      void write(
        setChatO,
        [[id, (m: ChatMessage) => ({ ...m, approvedAt: m.approvedAt ?? new Date().toISOString() })]],
        () => panelWrite(eventId, { op: "chat.moderate", id, action: "approve" }),
      ),
    [eventId, write, setChatO],
  );
  const pinnedId = feed.pinned?.id ?? null;
  const pinMessage = useCallback(
    (id: string, on: boolean) => {
      const patches: [string, (m: ChatMessage) => ChatMessage][] = [
        [
          id,
          (m) => ({
            ...m,
            pinned: on,
            approvedAt: on ? (m.approvedAt ?? new Date().toISOString()) : m.approvedAt,
          }),
        ],
      ];
      // One pin at a time, locally too.
      if (on && pinnedId && pinnedId !== id) {
        patches.push([pinnedId, (m) => ({ ...m, pinned: false })]);
      }
      void write(setChatO, patches, () =>
        panelWrite(eventId, { op: "chat.moderate", id, action: on ? "pin" : "unpin" }),
      );
    },
    [eventId, write, setChatO, pinnedId],
  );

  const spotlightId = feed.questions.find((q) => q.spotlighted)?.id ?? null;
  const qa = useMemo(
    () => ({
      vote: (id: string, on: boolean) =>
        void write(setQaO, [[id, voteOn(on)]], () =>
          panelWrite(eventId, { op: "qa.vote", id, on }),
        ),
      spotlight: (id: string, on: boolean) => {
        const patches: [string, (q: RoomQuestion) => RoomQuestion][] = [
          [
            id,
            (q) => ({
              ...q,
              spotlighted: on,
              ...(on ? { status: "open" as const, approvedAt: q.approvedAt ?? new Date().toISOString() } : {}),
            }),
          ],
        ];
        if (on && spotlightId && spotlightId !== id) {
          patches.push([spotlightId, (q) => ({ ...q, spotlighted: false })]);
        }
        void write(setQaO, patches, () => panelWrite(eventId, { op: "qa.spotlight", id, on }));
      },
      approve: (id: string) =>
        void write(
          setQaO,
          [[id, (q: RoomQuestion) => ({ ...q, approvedAt: q.approvedAt ?? new Date().toISOString() })]],
          () => panelWrite(eventId, { op: "qa.approve", id }),
        ),
      status: (id: string, status: RoomQuestion["status"]) =>
        void write(
          setQaO,
          [[id, (q: RoomQuestion) => ({ ...q, status, spotlighted: status === "open" && q.spotlighted })]],
          () => panelWrite(eventId, { op: "qa.status", id, status }),
        ),
    }),
    [eventId, write, setQaO, spotlightId],
  );

  const { refreshPolls, showError } = feed;
  const polls = useMemo(
    () => ({
      vote: (id: string, choice: number) =>
        void write(setPollO, [[id, chooseOption(choice)]], () =>
          panelWrite(eventId, { op: "poll.vote", id, choice }),
        ),
      setOpen: (id: string, open: boolean) =>
        void write(setPollO, [[id, (p: WebinarPoll) => ({ ...p, open })]], () =>
          panelWrite(eventId, { op: "poll.open", id, open }),
        ),
      create: async (input: PollInput) => {
        const res = await panelWrite(eventId, { op: "poll.create", ...input });
        if (res.ok) refreshPolls();
        else showError(res.error);
        return res;
      },
    }),
    [eventId, write, setPollO, refreshPolls, showError],
  );

  // --- unread --------------------------------------------------------------

  const root = useRef<HTMLDivElement>(null);
  const shown = useShown(root);
  const [seen, setSeen] = useState(() => ({
    chat: new Set(initial.chat.messages.map((m) => m.id)),
    qa: new Set(initial.questions.map((q) => q.id)),
    polls: new Set(initial.polls.filter((p) => p.open).map((p) => p.id)),
  }));
  useEffect(() => {
    if (!shown || active === "people") return;
    const ids =
      active === "chat"
        ? feed.chat.map((m) => m.id)
        : active === "qa"
          ? feed.questions.map((q) => q.id)
          : feed.polls.filter((p) => p.open).map((p) => p.id);
    setSeen((s) => {
      const have = s[active];
      if (ids.every((id) => have.has(id))) return s;
      return { ...s, [active]: new Set([...have, ...ids]) };
    });
  }, [shown, active, feed.chat, feed.questions, feed.polls]);

  const unread = useMemo<UnreadCounts>(
    () => ({
      chat: chatOn ? unseenCount(feed.chat, seen.chat) : 0,
      qa: unseenCount(feed.questions, seen.qa),
      polls: unseenOpenPolls(feed.polls, seen.polls),
    }),
    [chatOn, feed.chat, feed.questions, feed.polls, seen],
  );
  const onUnreadRef = useRef(onUnread);
  onUnreadRef.current = onUnread;
  useEffect(() => {
    onUnreadRef.current?.(unread);
  }, [unread]);

  return (
    <div
      ref={root}
      className={`${tone === "call" ? "dark" : ""} flex h-full min-h-0 flex-col bg-wash text-ink`}
    >
      <div role="tablist" aria-label="Webinar panel" className="flex shrink-0 gap-1 border-b border-line p-1.5">
        {tabs.map((t) => {
          const count = t === "people" ? 0 : unread[t];
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={active === t}
              onClick={() => onTabChange(t)}
              className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition ${
                active === t ? "bg-ink/10 text-ink" : "text-ink-soft hover:text-ink"
              }`}
            >
              {TAB_LABEL[t]}
              {count > 0 && active !== t && (
                <span className="min-w-4 rounded-full bg-phosphor px-1 text-[10px] leading-4 tabular-nums text-on-phosphor">
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {(feed.error || feed.offline) && (
        <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-line bg-amber-400/10 px-3 py-2 text-xs text-ink-soft">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="flex-1">{feed.error ?? "Reconnecting…"}</span>
          {feed.error && (
            <button type="button" onClick={feed.clearError} aria-label="Dismiss" className="text-ink-faint hover:text-ink">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {active === "chat" && (
        <ChatTab
          messages={feed.chat}
          pinned={feed.pinned}
          outbox={chatOutbox.items}
          audienceMode={feed.audienceMode}
          isHost={isHost}
          closed={closed}
          draft={chatDraft}
          onDraftChange={setChatDraft}
          onSend={chatOutbox.enqueue}
          onRetry={chatOutbox.retry}
          onDiscard={chatOutbox.discard}
          onRemove={removeMessage}
          onApprove={approveMessage}
          onPin={pinMessage}
        />
      )}
      {active === "qa" && (
        <QaTab
          questions={feed.questions}
          outbox={askOutbox.items}
          isHost={isHost}
          canUpvote={chatOn}
          needsApproval={needsApproval}
          closed={ended}
          draft={qaDraft}
          onDraftChange={setQaDraft}
          onAsk={askOutbox.enqueue}
          onRetry={askOutbox.retry}
          onDiscard={askOutbox.discard}
          onVote={qa.vote}
          onSpotlight={qa.spotlight}
          onApprove={qa.approve}
          onStatus={qa.status}
        />
      )}
      {active === "polls" && (
        <PollsTab
          polls={feed.polls}
          isHost={isHost}
          closed={closed}
          draft={pollDraft}
          onDraftChange={setPollDraft}
          onVote={polls.vote}
          onSetOpen={polls.setOpen}
          onCreate={polls.create}
        />
      )}
      {active === "people" && (
        <PeopleTab
          eventId={eventId}
          selfName={selfName}
          live={live}
          audienceCount={audienceCount}
        />
      )}
    </div>
  );
}

/** Is this element actually on screen (laid out, intersecting, tab visible)? */
function useShown(ref: RefObject<HTMLElement | null>): boolean {
  const [intersecting, setIntersecting] = useState(true);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setIntersecting(e.isIntersecting));
    io.observe(el);
    const onVis = () => setVisible(!document.hidden);
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ref]);
  return intersecting && visible;
}
