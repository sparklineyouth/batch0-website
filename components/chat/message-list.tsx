"use client";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  BellOff,
  BookOpen,
  CheckCircle2,
  CircleHelp,
  Copy,
  CornerUpLeft,
  Ban,
  Flag,
  FileText,
  Info,
  LifeBuoy,
  Loader2,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  SmilePlus,
  Trash2,
  Video,
} from "lucide-react";
import { canDeleteMessage, canEditMessage, sortedReactions, type ChatViewer } from "@/lib/chat-access";
import { composeMessage, decodeMentions, plainText, rawText, rebaseMentions, type PickedMention } from "@/lib/chat-format";
import { layoutMessages, localOffset } from "@/lib/chat-view";
import { attachmentKind, chatFileHref, formatBytes, isInlineImage } from "@/lib/chat-files-rules";
import { showsThread, type AboutChip, type QuestionState } from "@/lib/chat-threads-rules";
import { Avatar, RoleTag } from "./avatar";
import { MessageMarkup, type MarkupContext } from "./markup";
import { EmojiGrid, MenuItem, MenuSeparator, Popover } from "./popover";
import { DELETED_NAME, clockTime, dayLabel, enterSends, imeComposing, senderName, sinceLabel, stampLabel } from "./util";
import type { ChannelInfo, ChatPerson, ChatViewerInfo, UiMessage } from "./types";

const NEAR_BOTTOM_PX = 120;

export type MessageActions = {
  onReply: (m: UiMessage) => void;
  onEdit: (id: string, body: string) => Promise<string | null>;
  onDelete: (m: UiMessage) => void;
  onReact: (id: string, emoji: string) => void;
  onPin: (id: string) => void;
  onReport: (m: UiMessage) => void;
  /** Report a deleted message (a text channel's, by its id and sender): a reply's quote of one offers it. */
  onReportDeleted: (messageId: string, senderId: string) => void;
  onBlock: (userId: string) => void;
  onRetry: (m: UiMessage) => void;
  onDiscard: (id: string) => void;
  onMessagePerson: (userId: string) => void;
  /** "Ask the team for help" about this message. */
  onFlag: (m: UiMessage) => void;
  /** Staff: mute this person in chat. */
  onMute: (userId: string, name: string) => void;
  /** Open this message's thread (0110), in the side pane. */
  onOpenThread?: (m: UiMessage) => void;
  /** In a #help thread: accept this reply as the question's answer. */
  onAccept?: (m: UiMessage) => void;
};

/**
 * A list showing one thread's replies (the thread pane) rather than a
 * channel's feed: no thread buttons on replies (threads go one level), and
 * the question's accepted answer marked.
 */
export type ThreadMode = { answerId: string | null; canAccept: boolean };

/** A touch screen with no hover: actions open by tapping a message. */
const touchOnly = () => typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;

export function MessageList({
  viewer,
  channel,
  messages,
  people,
  online,
  blocked,
  cursor,
  markup,
  hasMoreBefore,
  loadingOlder,
  onLoadOlder,
  hasMoreAfter = false,
  onJumpToPresent,
  jumpTo,
  onJumped,
  editingId,
  setEditingId,
  actions,
  onNearBottom,
  emptyHint,
  lead = null,
  thread = null,
  composerId = "chat-composer",
  listKey,
  label = "Messages",
  unsentThreads,
}: {
  viewer: ChatViewerInfo;
  channel: ChannelInfo | null;
  messages: UiMessage[];
  people: Record<string, ChatPerson>;
  online: Set<string>;
  blocked: readonly string[];
  cursor: string | null;
  markup: MarkupContext;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** Showing a window around a jump target, with newer messages not loaded. */
  hasMoreAfter?: boolean;
  onJumpToPresent?: () => void;
  jumpTo: string | null;
  onJumped: () => void;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  actions: MessageActions;
  onNearBottom: (near: boolean) => void;
  emptyHint: React.ReactNode;
  /** Shown above everything, however far back the list goes: a thread's first message. */
  lead?: React.ReactNode;
  /** A thread's replies (the pane), not a channel's feed. */
  thread?: ThreadMode | null;
  /** The composer Escape goes back to. */
  composerId?: string;
  /** What resets the scroll position: the channel, or the thread. */
  listKey?: string;
  label?: string;
  /** The feed: roots with a thread reply that failed to send (ChatApp's outbox), said under each. */
  unsentThreads?: ReadonlySet<string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Day dividers and times are in the viewer's timezone, which the server
  // rendering this can't know: only once mounted.
  const [mounted, setMounted] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  /** The message whose actions are showing on a touch screen (tap to pick). */
  const [selected, setSelected] = useState<string | null>(null);
  /** The message the keyboard is on: the one Tab stop in the list. */
  const [active, setActive] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  useEffect(() => setMounted(true), []);

  // #staff's feed lines count as unread on the server, so the "new" line counts them too.
  const systemKey = channel?.systemKey ?? null;
  const rows = useMemo(
    () => layoutMessages(messages, { viewerId: viewer.id, cursor, offsetMinutes: mounted ? localOffset : null, systemKey }),
    [messages, viewer.id, cursor, mounted, systemKey],
  );

  const channelKey = listKey ?? channel?.id ?? "draft";
  const contentRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const prevCount = useRef(0);
  const prevFirst = useRef<string | null>(null);
  const prevLast = useRef<string | null>(null);
  const prevIds = useRef<Set<string>>(new Set());
  const prevHeight = useRef(0);
  const prevTop = useRef(0);
  const opened = useRef<string | null>(null);
  // Until the reader scrolls themselves, the opening position is re-applied
  // as late content (day dividers, fonts, images) changes the heights.
  const settled = useRef(false);
  const programmatic = useRef(false);
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const markupRef = useRef(markup);
  markupRef.current = markup;

  const isNearBottom = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  const remember = () => {
    const el = scrollRef.current;
    if (!el) return;
    prevTop.current = el.scrollTop;
    prevHeight.current = el.scrollHeight;
  };

  const setScroll = (top: number) => {
    const el = scrollRef.current;
    if (!el) return;
    programmatic.current = true;
    el.scrollTop = top;
    remember();
  };

  /** Open at the bottom — or at the "new" line when the unread run is taller than the screen. */
  const anchorOpening = () => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const line = el.querySelector<HTMLElement>("[data-new-line]");
    const lineY = line ? line.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : null;
    const atLine = lineY !== null && lineY - 80 < max;
    setScroll(atLine ? Math.max(0, (lineY as number) - 80) : max);
    nearBottom.current = !atLine || isNearBottom();
    onNearBottom(nearBottom.current);
  };

  // Scroll: open at the bottom (or the "new" line / a jump target), hold the
  // reader's place when older messages load above, follow new ones only when
  // the reader is already at the bottom (or just sent one from here).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = messages[0]?.id ?? null;
    const last = messages[messages.length - 1] ?? null;
    const ids = new Set(messages.map((m) => m.id));
    if (opened.current !== channelKey) {
      opened.current = channelKey;
      settled.current = false;
      prevCount.current = messages.length;
      prevFirst.current = first;
      prevLast.current = last?.id ?? null;
      prevIds.current = ids;
      setShowJump(false);
      setSelected(null);
      setActive(null);
      if (!jumpTo) anchorOpening();
      else remember();
      return;
    }
    const older = first !== prevFirst.current && messages.length > prevCount.current && !!prevFirst.current;
    if (older) {
      // Older messages loaded above: hold the reader's place. Chromium and
      // Firefox may have done it already (native scroll anchoring); Safari
      // hasn't. Move only what's left, or the reader lands a page lower.
      const target = prevTop.current + (el.scrollHeight - prevHeight.current);
      if (Math.abs(el.scrollTop - target) > 1) setScroll(target);
    } else if (messages.length > prevCount.current) {
      // A send from this screen follows itself down; a message from anyone
      // else (this account on another device included) only if the reader
      // is at the bottom already.
      const justSent = !!last?.pending && last.id !== prevLast.current;
      if (nearBottom.current || justSent) setScroll(el.scrollHeight);
      else setShowJump(true);
      // Screen readers hear what's new, from someone else — not the bulk
      // swaps (a page loading, a channel opening).
      const added = messages.filter((m) => !prevIds.current.has(m.id) && !m.pending && !m.failed);
      const theirs = added.filter((m) => m.kind === "message" && m.senderId !== viewer.id && !(m.senderId && blocked.includes(m.senderId)));
      if (theirs.length > 0 && added.length <= 5) {
        const m = theirs[theirs.length - 1];
        const ctx = markupRef.current;
        const text = plainText(m.body || "[attachment]", (id) => ctx.personName(id), (id) => ctx.channelName(id), 140);
        setAnnounce(`${senderName(m, peopleRef.current)}: ${text}`);
      }
    }
    prevCount.current = messages.length;
    prevFirst.current = first;
    prevLast.current = last?.id ?? null;
    prevIds.current = ids;
    remember();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, channelKey]);

  // Back to the present after reading around a jump target: the newest page
  // replaced the window, so land at its bottom. (Same channel only — opening
  // another one anchors as usual, at its "new" line.)
  const wasAround = useRef<{ key: string; on: boolean }>({ key: channelKey, on: hasMoreAfter });
  useLayoutEffect(() => {
    if (wasAround.current.on && !hasMoreAfter && wasAround.current.key === channelKey) {
      const el = scrollRef.current;
      if (el) setScroll(el.scrollHeight);
      nearBottom.current = true;
      onNearBottom(true);
      setShowJump(false);
    }
    wasAround.current = { key: channelKey, on: hasMoreAfter };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMoreAfter, channelKey]);

  // Day dividers arrive after hydration: re-anchor if the reader hasn't moved.
  useLayoutEffect(() => {
    if (mounted && !settled.current && !jumpTo) anchorOpening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // Images and fonts change heights after render: stay pinned to the bottom
  // when that's where the reader is.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (!el) return;
      if (!settled.current && !jumpTo) anchorOpening();
      else if (nearBottom.current) setScroll(el.scrollHeight);
      else remember();
    });
    ro.observe(content);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey]);

  useEffect(() => {
    if (!jumpTo) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-mid="${jumpTo}"]`);
    if (el) {
      settled.current = true;
      el.scrollIntoView({ block: "center" });
      remember();
      setFlash(jumpTo);
      setActive(jumpTo);
      const t = setTimeout(() => setFlash(null), 2000);
      onJumped();
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo, messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (programmatic.current) programmatic.current = false;
    else settled.current = true;
    remember();
    const near = isNearBottom();
    if (near !== nearBottom.current) {
      nearBottom.current = near;
      onNearBottom(near);
    }
    if (near) setShowJump(false);
    if (settled.current && el.scrollTop < 200 && hasMoreBefore && !loadingOlder) onLoadOlder();
  };

  const toBottom = () => {
    setShowJump(false);
    // Newer messages aren't loaded yet: the bottom of this window isn't now.
    if (hasMoreAfter && onJumpToPresent) return onJumpToPresent();
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // ↑/↓ (and Page Up/Down, Home/End) move between messages; Tab goes into
  // the one you're on. Escape goes back to the composer.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = e.target as HTMLElement;
    if (!row.matches("[data-mid]")) return;
    if (e.key === "Escape") {
      const composer = document.getElementById(composerId);
      if (composer && !(composer as HTMLTextAreaElement).disabled) {
        e.preventDefault();
        composer.focus();
      }
      return;
    }
    const all = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-mid]") ?? []);
    const at = all.indexOf(row);
    if (at === -1) return;
    const step: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 };
    let to: number | null = null;
    if (step[e.key] !== undefined) to = Math.max(0, Math.min(all.length - 1, at + step[e.key]));
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = all.length - 1;
    if (to === null) return;
    e.preventDefault();
    all[to].focus({ preventScroll: true });
    all[to].scrollIntoView({ block: "nearest" });
    if (to === 0 && (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") && hasMoreBefore && !loadingOlder) onLoadOlder();
  };

  const viewerRules: ChatViewer = useMemo(
    () => ({
      userId: viewer.id,
      staff: viewer.staff,
      vetted: viewer.vetted,
      cohortIds: [],
      teamIds: [],
      memberOf: channel && channel.kind !== "channel" && !channel.moderatorView ? [channel.id] : [],
    }),
    [viewer.id, viewer.staff, viewer.vetted, channel],
  );

  const onSelect = useCallback((id: string) => setSelected((cur) => (cur === id ? null : id)), []);
  const tabId = active && messages.some((m) => m.id === active) ? active : (messages[messages.length - 1]?.id ?? null);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>("[data-mid]");
          if (row?.dataset.mid) setActive(row.dataset.mid);
        }}
        className="h-full overflow-y-auto overscroll-contain"
        // Not a live region: opening a channel or loading older messages
        // swaps in dozens at once. New messages are announced below.
        role="log"
        aria-live="off"
        aria-label={label}
        aria-busy={loadingOlder || !mounted}
      >
        <div ref={contentRef} className="flex min-h-full flex-col justify-end pb-3 pt-6">
          {lead}
          {hasMoreBefore ? (
            <div className="flex justify-center py-3">
              <button
                type="button"
                onClick={onLoadOlder}
                disabled={loadingOlder}
                className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft hover:bg-wash"
              >
                {loadingOlder ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Load older messages
              </button>
            </div>
          ) : (
            <div className="px-4 pb-4 md:px-6">{emptyHint}</div>
          )}
          {rows.map((r) => {
            if (r.t === "day") {
              return (
                <div key={r.key} className="my-3 flex items-center gap-3 px-4 md:px-6" role="separator" aria-label={dayLabel(r.dayKey)}>
                  <span className="h-px flex-1 bg-line" />
                  <span className="font-mono text-[11px] text-ink-faint">{dayLabel(r.dayKey)}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              );
            }
            if (r.t === "new") {
              return (
                <div key="new" data-new-line className="my-2 flex items-center gap-3 px-4 md:px-6" role="separator" aria-label="New messages">
                  <span className="h-px flex-1 bg-phosphor" />
                  <span className="rounded bg-phosphor px-1.5 py-px font-mono text-[10px] font-semibold text-on-phosphor">NEW</span>
                </div>
              );
            }
            return (
              <MessageItem
                key={r.key}
                m={r.m}
                head={r.head}
                viewer={viewer}
                rules={viewerRules}
                channel={channel}
                sender={r.m.senderId ? people[r.m.senderId] : null}
                people={people}
                online={!!r.m.senderId && online.has(r.m.senderId)}
                blocked={!!r.m.senderId && blocked.includes(r.m.senderId)}
                markup={markup}
                editing={editingId === r.m.id}
                setEditingId={setEditingId}
                flash={flash === r.m.id}
                actions={actions}
                mounted={mounted}
                selected={selected === r.m.id}
                onSelect={onSelect}
                tabbable={tabId === r.m.id}
                thread={thread}
                composerId={composerId}
                threadUnsent={!!unsentThreads?.has(r.m.id)}
              />
            );
          })}
          {hasMoreAfter ? (
            <div className="flex justify-center py-3">
              <button
                type="button"
                onClick={onJumpToPresent}
                className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft hover:bg-wash"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                You're reading older messages · Jump to present
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
      {showJump ? (
        <button
          type="button"
          onClick={toBottom}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-phosphor px-3 py-1.5 text-xs font-semibold text-on-phosphor shadow-cta"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          New messages
        </button>
      ) : null}
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  m,
  head,
  viewer,
  rules,
  channel,
  sender,
  people,
  online,
  blocked,
  markup,
  editing,
  setEditingId,
  flash,
  actions,
  mounted,
  selected,
  onSelect,
  tabbable,
  thread,
  composerId,
  threadUnsent,
}: {
  m: UiMessage;
  head: boolean;
  viewer: ChatViewerInfo;
  rules: ChatViewer;
  channel: ChannelInfo | null;
  sender: ChatPerson | null | undefined;
  people: Record<string, ChatPerson>;
  online: boolean;
  blocked: boolean;
  markup: MarkupContext;
  editing: boolean;
  setEditingId: (id: string | null) => void;
  flash: boolean;
  actions: MessageActions;
  /**
   * Times are in the viewer's zone and locale, which the server rendering
   * this can't know: render them only once mounted, or hydration mismatches.
   */
  mounted: boolean;
  /** Its actions are showing (a tap, on a touch screen). */
  selected: boolean;
  onSelect: (id: string) => void;
  /** The list's one Tab stop. */
  tabbable: boolean;
  /** In a thread's pane (0110): its question's answer, and who may accept one. */
  thread: ThreadMode | null;
  composerId: string;
  /** In the feed: a reply to this message's thread failed to send, and waits in the thread with its Retry. */
  threadUnsent: boolean;
}) {
  const [menu, setMenu] = useState<"emoji" | "more" | null>(null);
  const [reveal, setReveal] = useState(false);
  /** Focus is somewhere in this message: its actions are in the Tab order. */
  const [focused, setFocused] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const emojiRef = useRef<HTMLButtonElement>(null);
  const name = senderName(m, people);
  const mine = !!m.senderId && m.senderId === viewer.id;
  const live = !m.pending && !m.failed;
  // A frozen DM or group (a block, a departed account, the safeguarding rule,
  // a fine) takes no edits or pins either — the server refuses them, so don't
  // offer them. Reactions follow canReact: a text channel you can't post in
  // still takes them (#announcements), unless you're muted or fined.
  const readOnly = !channel || channel.archived || channel.moderatorView || (channel.kind !== "channel" && !channel.compose.ok);
  const canReact = !!channel?.canReact;
  const mentioned = !mine && (m.mentions.includes(viewer.id) || m.mentionEveryone);
  const rowFocus = "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/30";
  // Shown on hover, focus, a tap (touch) or an open menu. Hidden with
  // opacity, not display/visibility, so focus can always land on (or come
  // back to) a button in it — and out of the Tab order until then, so Tab
  // doesn't walk through every message's toolbar. Everything else in the
  // message (its avatar, links, chips, files, reactions) joins the Tab order
  // on the same terms: the list is one Tab stop, ↑/↓ move between messages.
  const showTools = menu !== null || selected || focused;
  const tab = showTools ? 0 : -1;
  const focusWithin = {
    onFocus: () => setFocused(true),
    onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
    },
  };

  if (m.kind === "system") {
    return (
      <div data-mid={m.id} tabIndex={tabbable ? 0 : -1} role="article" {...focusWithin} className={`flex items-start gap-2 px-4 py-1 text-xs text-ink-faint md:px-6 ${rowFocus}`}>
        {/pinned a message/.test(m.body) ? (
          <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <MessageMarkup body={m.body} ctx={markup} compact tabbable={showTools} />
        </span>
        <span className="shrink-0 font-mono text-[10px]">{mounted ? clockTime(m.createdAt) : ""}</span>
      </div>
    );
  }

  if (blocked && !reveal) {
    return (
      <div data-mid={m.id} tabIndex={tabbable ? 0 : -1} role="article" {...focusWithin} className={`px-4 py-1 md:px-6 ${rowFocus}`}>
        <button
          type="button"
          tabIndex={tab}
          onClick={() => setReveal(true)}
          className="ml-12 text-xs text-ink-faint underline-offset-2 hover:underline"
        >
          Message from someone you blocked — show
        </button>
      </div>
    );
  }

  const canEdit = live && !readOnly && !!channel?.compose.ok && canEditMessage({ senderId: m.senderId, kind: m.kind, deletedAt: null }, rules);
  const canDelete =
    live &&
    !(channel?.archived && !viewer.staff) &&
    canDeleteMessage({ senderId: m.senderId, kind: m.kind, deletedAt: null }, { id: channel?.id ?? "", kind: channel?.kind ?? "dm" }, rules);
  const reactions = sortedReactions(m.reactions);
  // Threads (0110): a feed message in a text channel can start one; a reply
  // in a thread can't (one level), and the pane marks the accepted answer.
  const canThread = !thread && live && !!channel?.threads && m.kind === "message" && !m.threadRootId && !!actions.onOpenThread;
  const isAnswer = !!thread && !!thread.answerId && thread.answerId === m.id;
  const canAccept = !!thread && thread.canAccept && live && m.kind === "message" && !isAnswer && !!actions.onAccept;
  // A person to message: someone else, with an account.
  const other = !mine && !!m.senderId && !!sender;
  const first = name.split(" ")[0];

  const copyText = () => {
    const text = rawText(m.body, (id) => people[id]?.name ?? markup.personName(id), (id) => markup.channelName(id));
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  return (
    <div
      data-mid={m.id}
      tabIndex={tabbable ? 0 : -1}
      role="article"
      aria-label={head ? undefined : `${name}, continued`}
      onClick={(e) => {
        // Touch: a tap on the message (not on a link or button in it) shows its actions.
        if (!touchOnly() || (e.target as HTMLElement).closest("a, button, input, textarea, [role='button']")) return;
        onSelect(m.id);
      }}
      {...focusWithin}
      onContextMenu={(e) => {
        // A long press on a touch screen opens the menu (a right click on a
        // desktop keeps the browser's).
        if (!live || editing || !touchOnly()) return;
        e.preventDefault();
        if (!selected) onSelect(m.id);
        setMenu("more");
      }}
      className={`group relative px-4 md:px-6 ${head ? "mt-3 pt-0.5" : ""} ${
        mentioned ? "border-l-2 border-phosphor bg-phosphor/10" : "border-l-2 border-transparent"
      } ${flash || selected ? "bg-phosphor/20" : ""} ${m.pending ? "opacity-60" : ""} hover:bg-wash/70 ${rowFocus}`}
    >
      {head && m.replyTo ? (
        <ReplyQuote
          reply={m.replyTo}
          people={people}
          markup={markup}
          tab={tab}
          // A quote of a deleted message is the one place a text channel still
          // shows it was there: it's a report target (body-free, like the
          // channel menu's list). Never your own.
          onReport={
            live && channel?.kind === "channel" && m.replyTo.deleted && m.replyTo.senderId && m.replyTo.senderId !== viewer.id
              ? () => actions.onReportDeleted(m.replyTo!.id, m.replyTo!.senderId!)
              : null
          }
        />
      ) : null}
      <div className="flex gap-3">
        <div className="w-9 shrink-0">
          {head ? (
            other ? (
              <button type="button" tabIndex={tab} onClick={() => actions.onMessagePerson(m.senderId!)} aria-label={`Message ${name}`}>
                <Avatar name={name} online={online} size={36} />
              </button>
            ) : (
              <Avatar name={name} online={online} size={36} />
            )
          ) : (
            <span className="invisible block pt-1 text-right font-mono text-[10px] text-ink-faint group-hover:visible">
              {mounted ? clockTime(m.createdAt) : ""}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 pb-0.5">
          {head ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="min-w-0 max-w-full text-sm font-semibold text-ink [overflow-wrap:anywhere]">{name}</span>
              <RoleTag person={sender} />
              <time dateTime={m.createdAt} className="font-mono text-[11px] text-ink-faint">
                {mounted ? stampLabel(m.createdAt) : ""}
              </time>
              {m.pinnedAt ? <Pin className="h-3 w-3 text-phosphor-ink" aria-label="Pinned" /> : null}
              {isAnswer ? <AnswerBadge /> : null}
            </div>
          ) : isAnswer ? (
            <AnswerBadge />
          ) : null}

          {editing ? (
            <EditBox
              m={m}
              people={people}
              onDone={() => {
                setEditingId(null);
                // Back to where the ↑ (or the Edit button) came from.
                document.getElementById(composerId)?.focus({ preventScroll: true });
              }}
              onSave={(body) => actions.onEdit(m.id, body)}
            />
          ) : (
            <div className="text-[15px] leading-relaxed text-ink">
              {m.body ? <MessageMarkup body={m.body} ctx={markup} tabbable={showTools} /> : null}
              {m.editedAt ? <span className="ml-1 text-[10px] text-ink-faint">(edited)</span> : null}
            </div>
          )}

          {m.attachments.length > 0 ? <Attachments m={m} tab={tab} /> : null}

          {reactions.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {reactions.map((r) => {
                const mineToo = r.userIds.includes(viewer.id);
                const who = r.userIds.map((id) => (id === viewer.id ? "You" : (people[id]?.name ?? "Someone"))).join(", ");
                return (
                  <button
                    key={r.emoji}
                    type="button"
                    tabIndex={tab}
                    disabled={!live || !canReact}
                    onClick={() => actions.onReact(m.id, r.emoji)}
                    title={`${who} reacted with ${r.emoji}`}
                    aria-label={`${r.emoji} ${r.userIds.length}: ${who}`}
                    aria-pressed={mineToo}
                    className={`inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs ${
                      mineToo ? "border-phosphor bg-phosphor/15 text-ink" : "border-line bg-paper text-ink-soft hover:border-ink/30"
                    }`}
                  >
                    <span>{r.emoji}</span>
                    <span className="font-mono text-[11px]">{r.userIds.length}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {!thread && channel?.threads && (showsThread(m.thread) || !!m.thread?.about || threadUnsent) && actions.onOpenThread ? (
            <ThreadLine m={m} tab={tab} mounted={mounted} unsent={threadUnsent} onOpen={() => actions.onOpenThread!(m)} />
          ) : null}

          {m.failed ? (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
              {m.failed}{" "}
              <button type="button" tabIndex={tab} className="underline" onClick={() => actions.onRetry(m)}>
                Retry
              </button>{" "}
              ·{" "}
              <button type="button" tabIndex={tab} className="underline" onClick={() => actions.onDiscard(m.id)}>
                Discard
              </button>
            </p>
          ) : null}
        </div>
      </div>

      {live && !editing ? (
        <div
          role="group"
          aria-label={`Actions for this message from ${name}`}
          className={`absolute -top-3 right-4 z-10 flex items-center rounded-md border border-line bg-paper shadow-[0_2px_8px_rgb(0_0_0/0.08)] md:right-6 ${
            showTools ? "opacity-100" : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:pointer-events-none"
          }`}
        >
          {canReact ? (
            <ToolbarButton ref={emojiRef} label="Add a reaction" tabbable={showTools} expanded={menu === "emoji"} onClick={() => setMenu(menu === "emoji" ? null : "emoji")}>
              <SmilePlus className="h-4 w-4" />
            </ToolbarButton>
          ) : null}
          {canThread ? (
            <ToolbarButton
              label={showsThread(m.thread) ? "Open thread" : "Reply in thread"}
              tabbable={showTools}
              threadOpener={m.id}
              onClick={() => { setMenu(null); actions.onOpenThread!(m); }}
            >
              <MessagesSquare className="h-4 w-4" />
            </ToolbarButton>
          ) : null}
          {!readOnly && channel?.compose.ok ? (
            // In #help a feed reply is a quote in the channel, not an answer
            // in the question's thread: say so, beside "Reply in thread".
            <ToolbarButton
              label={thread ? "Quote in reply" : channel?.threads && channel.questionChannel ? "Quote in channel" : "Reply"}
              tabbable={showTools}
              onClick={() => { setMenu(null); actions.onReply(m); }}
            >
              <CornerUpLeft className="h-4 w-4" />
            </ToolbarButton>
          ) : null}
          {canEdit ? (
            <ToolbarButton label="Edit" tabbable={showTools} onClick={() => { setMenu(null); setEditingId(m.id); }}>
              <Pencil className="h-4 w-4" />
            </ToolbarButton>
          ) : null}
          <ToolbarButton ref={moreRef} label="More" tabbable={showTools} menu expanded={menu === "more"} onClick={() => setMenu(menu === "more" ? null : "more")}>
            <MoreHorizontal className="h-4 w-4" />
          </ToolbarButton>
          <Popover open={menu === "emoji"} onClose={() => setMenu(null)} toggleRef={emojiRef} className="right-0 top-9">
            <EmojiGrid
              onPick={(e) => {
                setMenu(null);
                emojiRef.current?.focus({ preventScroll: true });
                actions.onReact(m.id, e);
              }}
            />
          </Popover>
          <Popover open={menu === "more"} onClose={() => setMenu(null)} toggleRef={moreRef} className="right-0 top-9 w-64">
            <div role="menu" aria-label="Message actions">
              {canAccept ? (
                <MenuItem icon={CheckCircle2} onClick={() => { setMenu(null); actions.onAccept!(m); }}>
                  Accept as the answer
                </MenuItem>
              ) : null}
              {channel?.canPin && !readOnly && !m.threadRootId ? (
                <MenuItem icon={m.pinnedAt ? PinOff : Pin} onClick={() => { setMenu(null); actions.onPin(m.id); }}>
                  {m.pinnedAt ? "Unpin" : "Pin message"}
                </MenuItem>
              ) : null}
              <MenuItem icon={Copy} onClick={() => { setMenu(null); copyText(); }}>
                Copy text
              </MenuItem>
              {other ? (
                <MenuItem icon={MessageSquare} onClick={() => { setMenu(null); actions.onMessagePerson(m.senderId!); }}>
                  Message {first}
                </MenuItem>
              ) : null}
              {channel?.kind === "channel" && !channel.moderatorView ? (
                <MenuItem icon={LifeBuoy} onClick={() => { setMenu(null); actions.onFlag(m); }}>
                  Ask the team for help
                </MenuItem>
              ) : null}
              {canDelete ? (
                <MenuItem icon={Trash2} danger onClick={() => { setMenu(null); actions.onDelete(m); }}>
                  {mine ? "Delete message" : "Remove message"}
                </MenuItem>
              ) : null}
              {!mine && m.senderId && !channel?.moderatorView ? (
                <>
                  <MenuSeparator />
                  {viewer.staff && !sender?.isStaff ? (
                    <MenuItem icon={BellOff} danger onClick={() => { setMenu(null); actions.onMute(m.senderId!, name); }}>
                      Mute in chat
                    </MenuItem>
                  ) : null}
                  <MenuItem icon={Flag} danger onClick={() => { setMenu(null); actions.onReport(m); }}>
                    Report message
                  </MenuItem>
                  <MenuItem icon={Ban} danger onClick={() => { setMenu(null); actions.onBlock(m.senderId!); }}>
                    {blocked ? "Unblock" : "Block"} {first}
                  </MenuItem>
                </>
              ) : null}
            </div>
          </Popover>
        </div>
      ) : null}
    </div>
  );
});

function ToolbarButton({
  ref,
  label,
  onClick,
  tabbable,
  menu = false,
  expanded,
  threadOpener,
  children,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  label: string;
  tabbable: boolean;
  onClick: () => void;
  /** Opens a menu (aria-haspopup). */
  menu?: boolean;
  /** Its popover is open. */
  expanded?: boolean;
  /** It opens this message's thread: focus comes back here when the pane closes. */
  threadOpener?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      data-thread-opener={threadOpener}
      tabIndex={tabbable ? 0 : -1}
      aria-label={label}
      title={label}
      aria-haspopup={menu ? "menu" : expanded !== undefined ? "true" : undefined}
      aria-expanded={expanded}
      className="inline-flex h-8 w-8 items-center justify-center text-ink-soft hover:bg-wash hover:text-ink"
    >
      {children}
    </button>
  );
}

/** "Open question" / "Answered": #help's question state (0110), in words, not only a colour. */
export function QuestionBadge({ state }: { state: QuestionState }) {
  return state === "answered" ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-phosphor/50 bg-phosphor/10 px-1.5 py-px text-[11px] font-medium text-phosphor-ink">
      <CheckCircle2 className="h-3 w-3" aria-hidden />
      Answered
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[11px] font-medium text-amber-800 dark:text-amber-200">
      <CircleHelp className="h-3 w-3" aria-hidden />
      Open question
    </span>
  );
}

function AnswerBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-phosphor/15 px-1.5 py-px text-[11px] font-medium text-phosphor-ink">
      <CheckCircle2 className="h-3 w-3" aria-hidden />
      Accepted answer
    </span>
  );
}

/** "About: Lesson · Customer interviews" — only ever for an item this viewer can open (lib/chat-about.ts). */
export function AboutLink({ about, tab = 0 }: { about: AboutChip; tab?: number }) {
  return (
    <a
      href={about.href}
      tabIndex={tab}
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-soft hover:border-ink/30 hover:text-ink"
    >
      <BookOpen className="h-3 w-3 shrink-0" aria-hidden />
      <span className="shrink-0">About {about.kind === "lesson" ? "lesson" : "assignment"}:</span>
      <span className="min-w-0 truncate font-medium">{about.title}</span>
    </a>
  );
}

const NO_THREAD = { replyCount: 0, lastReplyAt: null, question: null, answerId: null } as const;

/**
 * Under a message that starts a thread: its question state, "4 replies ·
 * 3h", and what it's about — and, when a reply to it didn't send, that it's
 * waiting in the thread with its Retry. One button opens the thread; its
 * label says all of it for a screen reader. With no replies yet it says
 * "Reply in thread", the same as the toolbar's button, so it's never
 * mistaken for the toolbar's quote-in-the-channel.
 */
function ThreadLine({ m, tab, mounted, unsent, onOpen }: { m: UiMessage; tab: number; mounted: boolean; unsent: boolean; onOpen: () => void }) {
  const t = m.thread ?? NO_THREAD;
  const count = t.replyCount === 0 ? "No replies yet" : `${t.replyCount} ${t.replyCount === 1 ? "reply" : "replies"}`;
  const state = t.question ? `, question ${t.question === "answered" ? "answered" : "open"}` : "";
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
      {t.question ? <QuestionBadge state={t.question} /> : null}
      <button
        type="button"
        tabIndex={tab}
        data-thread-opener={m.id}
        onClick={onOpen}
        aria-label={`${count}${state}. Open thread`}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-phosphor-ink hover:bg-wash"
      >
        <MessagesSquare className="h-3.5 w-3.5" aria-hidden />
        {t.replyCount === 0 ? "Reply in thread" : count}
        {t.replyCount > 0 && t.lastReplyAt && mounted ? (
          <span className="font-normal text-ink-faint">· {sinceLabel(t.lastReplyAt)}</span>
        ) : null}
      </button>
      {m.thread?.about ? <AboutLink about={m.thread.about} tab={tab} /> : null}
      {unsent ? (
        <span role="alert" className="text-red-600 dark:text-red-400">
          A reply didn&apos;t send. Open the thread to retry.
        </span>
      ) : null}
    </div>
  );
}

function ReplyQuote({
  reply,
  people,
  markup,
  tab,
  onReport,
}: {
  reply: NonNullable<UiMessage["replyTo"]>;
  people: Record<string, ChatPerson>;
  markup: MarkupContext;
  /** -1 keeps the Report button out of the Tab order until focus is in the message. */
  tab: number;
  /** A deleted original that can be reported from here. */
  onReport: (() => void) | null;
}) {
  const who = reply.senderId ? (people[reply.senderId]?.name ?? "Someone") : DELETED_NAME;
  return (
    <div className="mb-0.5 ml-12 flex min-w-0 items-center gap-1.5 text-xs text-ink-faint">
      <CornerUpLeft className="h-3 w-3 shrink-0 -scale-x-100" />
      {reply.deleted ? (
        <>
          <span className="italic">Original message was deleted</span>
          {onReport ? (
            <button type="button" tabIndex={tab} onClick={onReport} className="underline-offset-2 hover:underline">
              Report it
            </button>
          ) : null}
        </>
      ) : !reply.preview ? (
        // The original isn't loaded here yet.
        <span className="italic">Replying to a message</span>
      ) : (
        <>
          <span className="min-w-0 max-w-[40%] shrink-0 truncate font-semibold text-ink-soft">@{who}</span>
          <span className="min-w-0 truncate">
            {plainText(reply.preview, (id) => people[id]?.name ?? markup.personName(id), (id) => markup.channelName(id), 120, { cut: true })}
          </span>
        </>
      )}
    </div>
  );
}

/** `tab`: -1 keeps the links out of the Tab order until focus is in the message. */
export function Attachments({ m, tab }: { m: UiMessage; tab: number }) {
  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap gap-2">
      {m.attachments.map((a, i) => {
        // While sending, the file isn't readable through the route yet.
        if (m.pending || m.failed) {
          return (
            <span key={a.path} className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-soft">
              <FileText className="h-4 w-4 shrink-0" />
              <span className="min-w-0 truncate">{a.name}</span>
            </span>
          );
        }
        if (isInlineImage(a)) {
          return (
            <a key={a.path} href={chatFileHref(m.id, i)} target="_blank" rel="noopener noreferrer" tabIndex={tab} className="block max-w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={chatFileHref(m.id, i)}
                alt={a.name}
                loading="lazy"
                className="max-h-72 max-w-[min(100%,28rem)] rounded-md border border-line object-contain"
              />
            </a>
          );
        }
        const kind = attachmentKind({ contentType: a.type, fileName: a.name });
        const Icon = kind === "video" ? Video : FileText;
        return (
          <a
            key={a.path}
            href={chatFileHref(m.id, i, { download: true })}
            tabIndex={tab}
            className="inline-flex min-w-0 max-w-full items-center gap-2.5 rounded-md border border-line bg-paper px-3 py-2 text-sm hover:border-ink/30"
          >
            <Icon className="h-5 w-5 shrink-0 text-ink-faint" />
            <span className="min-w-0">
              <span className="block truncate font-medium text-ink">{a.name}</span>
              <span className="block font-mono text-[11px] text-ink-faint">{formatBytes(a.size)}</span>
            </span>
          </a>
        );
      })}
    </div>
  );
}

function EditBox({
  m,
  people,
  onDone,
  onSave,
}: {
  m: UiMessage;
  people: Record<string, ChatPerson>;
  /** Saved or cancelled: close the box. */
  onDone: () => void;
  /** Returns why it didn't save, or null. */
  onSave: (body: string) => Promise<string | null>;
}) {
  const decoded = useMemo(() => decodeMentions(m.body, (id) => people[id]?.name), [m.body, people]);
  const [text, setText] = useState(decoded.text);
  const [picked, setPicked] = useState<PickedMention[]>(decoded.picked);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    let err: string | null;
    try {
      err = await onSave(composeMessage(text, picked));
    } catch {
      err = "Couldn't save that edit.";
    } finally {
      setSaving(false);
    }
    if (err) setError(err);
    else onDone();
  };
  return (
    <div className="mt-1">
      <textarea
        ref={ref}
        value={text}
        aria-label="Edit message"
        onChange={(e) => {
          const next = e.target.value;
          setPicked((p) => rebaseMentions(text, next, p, e.target.selectionEnd ?? undefined));
          setText(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          } else if (e.key === "Enter" && !e.shiftKey && !imeComposing(e) && enterSends()) {
            e.preventDefault();
            void save();
          }
        }}
        enterKeyHint={enterSends() ? "send" : "enter"}
        rows={1}
        className="w-full resize-none rounded-md border border-line bg-paper px-3 py-2 text-base text-ink focus:border-ink/40 focus:outline-none md:text-[15px]"
      />
      <p className="mt-1 text-[11px] text-ink-faint">
        Escape to <button type="button" className="link-ink" onClick={onDone}>cancel</button> · {enterSends() ? "Enter to " : ""}
        <button type="button" className="link-ink" onClick={() => void save()}>save</button>
        {saving ? " · saving…" : ""}
      </p>
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">{error}</p> : null}
    </div>
  );
}
