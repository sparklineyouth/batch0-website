"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { isAfter, toggleReaction as applyToggle } from "@/lib/chat-access";
import { plainText } from "@/lib/chat-format";
import { mergeMessages, reconcilePage, settledBy } from "@/lib/chat-view";
import type { ChannelTarget } from "@/lib/chat-payload";
import {
  deleteMessage,
  editMessage,
  fetchChannel,
  markAllRead,
  markRead,
  sendMessage,
  togglePin,
  toggleReaction,
} from "@/app/chat/actions";
import { ChatSidebar } from "./sidebar";
import { ChannelView } from "./channel-view";
import { SidePanel } from "./side-panels";
import { NewConversationDialog, QuickSwitcher } from "./dialogs";
import { useMessageFeed, usePing, usePresence, useTyping, pingDelay, type LiveRow } from "./use-chat-live";
import { ChatReadError, NOT_AVAILABLE, READ_FAILED, chatApi, dropQueuedPush, holdChatUrl, serverSaidNo, tracked, writeChatUrl } from "./api";
import type { ChatPerson, ChannelPayload, ChatViewerInfo, Panel, SidebarData, SidebarItem, UiMessage } from "./types";
import { OFFLINE, newClientId, resultError } from "./util";
import { applyUpdate, bumpSidebarRow, has, localOnly, pendingTwin, sameMessage, toQuote, toUiMessage, withoutMessage } from "./live-rows";

/**
 * batch0 Chat, the client. Owns the sidebar, the open channel, a small cache
 * of recently opened channels (so switching back is instant), and the live
 * feed. Every write goes through app/chat/actions.ts and every read through
 * app/chat/api/*, which re-check everything; nothing here is a security
 * boundary.
 *
 * `messages`, `payload` and `sidebar` live in state for rendering, but their
 * refs are the source of truth and are written synchronously by the setters
 * below:
 * Realtime callbacks and action continuations run between renders, and a ref
 * that only caught up at the next render let an old channel's message land in
 * the new one.
 */

const POLL_MS = 30_000;
const PRESENCE_MS = 60_000;
/** markRead at most this often while messages keep arriving (the cursor never goes backwards, so batching loses nothing). */
const MARK_EVERY_MS = 10_000;
const CACHE_MAX = 12;
/** A long session at the bottom of a busy channel keeps this many messages, not all of them. */
const LIVE_MAX = 300;
const LIVE_TRIM_AT = LIVE_MAX + 50;
const TOUCHED_MAX = 2_000;

type Cached = { payload: ChannelPayload; messages: UiMessage[]; hasMoreBefore: boolean; at: number };
type Reply = NonNullable<UiMessage["replyTo"]>;

export function ChatApp({
  viewer,
  home,
  homeLabel,
  initialSidebar,
  initialPayload,
  initialError,
}: {
  viewer: ChatViewerInfo;
  home: string;
  homeLabel: string;
  initialSidebar: SidebarData;
  initialPayload: ChannelPayload | null;
  initialError: string | null;
}) {
  const params = useSearchParams();
  const [sidebar, setSidebarState] = useState(initialSidebar);
  const [payload, setPayloadState] = useState<ChannelPayload | null>(initialPayload);
  const [messages, setMessagesState] = useState<UiMessage[]>(initialPayload?.messages ?? []);
  const [people, setPeople] = useState<Record<string, ChatPerson>>(() => ({
    ...initialSidebar.people,
    ...(initialPayload?.people ?? {}),
  }));
  const [loading, setLoading] = useState(false);
  /** While an uncached conversation loads: its name, for the header. */
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [panel, setPanel] = useState<Panel>(null);
  // A phone shows one pane. It opens on the list unless the link named a
  // conversation (or one that failed, so its error is what shows).
  const [mobilePane, setMobilePane] = useState<"list" | "channel">(() =>
    initialError || (initialPayload && (params?.get("c") || params?.get("to") || params?.get("team"))) ? "channel" : "list",
  );
  const [wide, setWide] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [jumpTo, setJumpTo] = useState<string | null>(initialPayload?.focusId ?? null);
  const [hasMoreBefore, setHasMoreBefore] = useState(initialPayload?.hasMoreBefore ?? false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // ---- The synchronous refs (see the header) ----
  const payloadRef = useRef(initialPayload);
  const channelIdRef = useRef<string | null>(initialPayload?.channel?.id ?? null);
  // Reading a window around a jump target, newer messages not loaded: live
  // inserts and resyncs would land after it with a silent gap in between.
  const hasMoreAfterRef = useRef(!!initialPayload?.channel && !!initialPayload.hasMoreAfter);
  const messagesRef = useRef(messages);
  const setPayload = useCallback((next: ChannelPayload | null | ((p: ChannelPayload | null) => ChannelPayload | null)) => {
    const value = typeof next === "function" ? next(payloadRef.current) : next;
    payloadRef.current = value;
    channelIdRef.current = value?.channel?.id ?? null;
    hasMoreAfterRef.current = !!value?.channel && !!value.hasMoreAfter;
    setPayloadState(value);
  }, []);
  const setMessages = useCallback((next: UiMessage[] | ((list: UiMessage[]) => UiMessage[])) => {
    const value = typeof next === "function" ? next(messagesRef.current) : next;
    if (value === messagesRef.current) return;
    messagesRef.current = value;
    setMessagesState(value);
  }, []);
  // A live insert asks "is this conversation in the sidebar?" right after
  // other updates were queued; React would run a queued updater too late to
  // answer, and every message refetched the whole sidebar.
  const sidebarRef = useRef(initialSidebar);
  const setSidebar = useCallback((next: SidebarData | ((s: SidebarData) => SidebarData)) => {
    const value = typeof next === "function" ? next(sidebarRef.current) : next;
    if (value === sidebarRef.current) return;
    sidebarRef.current = value;
    setSidebarState(value);
  }, []);
  /** False once ChatApp has gone (a link out of chat): late answers mustn't touch the address bar. */
  const alive = useRef(true);

  const hasMoreBeforeRef = useRef(hasMoreBefore);
  hasMoreBeforeRef.current = hasMoreBefore;
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const mobilePaneRef = useRef(mobilePane);
  mobilePaneRef.current = mobilePane;
  const wideRef = useRef(wide);
  wideRef.current = wide;
  const nearBottomRef = useRef(true);
  const cache = useRef(new Map<string, Cached>());
  /** When this tab last sent in each channel: a cached payload's slow-mode wait counts from it. */
  const lastSentAt = useRef(new Map<string, number>());
  /** The newest message marked read, per channel. */
  const readUpTo = useRef(new Map<string, string>());
  /**
   * When a live change (or this tab's own write) last landed on a message,
   * and which messages were deleted while the page was open. A page or
   * snapshot requested before that is older than what's on screen: it must
   * not bring a deleted message back, or an edit's old words.
   */
  const touched = useRef(new Map<string, number>());
  const deleted = useRef(new Set<string>());

  const channelId = payload?.channel?.id ?? null;
  const online = usePresence(viewer.id);
  const memberIds = payload?.channel && payload.channel.kind !== "channel" ? payload.channel.memberIds : null;
  const typingAccept = useCallback((id: string) => !memberIds || memberIds.includes(id), [memberIds]);
  const { typing, notify: notifyTyping, stop: stopTyping } = useTyping(channelId, viewer.id, typingAccept);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const touch = useCallback((id: string) => {
    const t = touched.current;
    t.delete(id);
    t.set(id, Date.now());
    if (t.size > TOUCHED_MAX) t.delete(t.keys().next().value as string);
  }, []);

  /**
   * A page from the server, made safe to merge into `onScreen`: messages
   * deleted since are left out (and their quotes blanked), a message changed
   * live since `since` keeps its on-screen copy, and an unchanged one keeps
   * its on-screen object so nothing re-renders for it.
   */
  const freshen = useCallback((page: readonly UiMessage[], since: number, onScreen: readonly UiMessage[]): UiMessage[] => {
    const byId = new Map(onScreen.map((m) => [m.id, m]));
    const out: UiMessage[] = [];
    for (const incoming of page) {
      if (deleted.current.has(incoming.id)) continue;
      const cur = byId.get(incoming.id);
      let m = incoming;
      if (cur && ((touched.current.get(m.id) ?? 0) >= since || sameMessage(cur, m))) m = cur;
      const reply = m.replyTo;
      if (reply && !reply.deleted) {
        if (deleted.current.has(reply.id)) m = { ...m, replyTo: { ...reply, preview: "", deleted: true } };
        else if ((touched.current.get(reply.id) ?? 0) >= since && cur?.replyTo) m = { ...m, replyTo: cur.replyTo };
      }
      out.push(m);
    }
    return out;
  }, []);

  const addPeople = useCallback((more: Record<string, ChatPerson> | undefined) => {
    if (!more) return;
    setPeople((prev) => {
      let next: Record<string, ChatPerson> | null = null;
      for (const [id, p] of Object.entries(more)) {
        const cur = prev[id];
        if (cur && cur.name === p.name && cur.roleLabel === p.roleLabel && cur.roleColor === p.roleColor && cur.isStaff === p.isStaff && cur.isStudent === p.isStudent) continue;
        next ??= { ...prev };
        next[id] = p;
      }
      return next ?? prev;
    });
  }, []);

  /** Put the open channel (with its unsent bubbles and loaded history) in the cache before leaving it. */
  const stash = useCallback(() => {
    const p = payloadRef.current;
    const id = p?.channel?.id;
    if (!p || !id) return;
    const c = cache.current;
    c.delete(id);
    c.set(id, { payload: p, messages: messagesRef.current, hasMoreBefore: hasMoreBeforeRef.current, at: Date.now() });
    while (c.size > CACHE_MAX) c.delete(c.keys().next().value as string);
  }, []);

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /** Is the open conversation on screen for someone to read? */
  const onScreen = () =>
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    (wideRef.current || mobilePaneRef.current === "channel");

  const lastMark = useRef<{ id: string | null; at: number }>({ id: null, at: 0 });
  const markTimer = useRef<{ id: string; upTo: string; t: ReturnType<typeof setTimeout> } | null>(null);

  const clearBadge = useCallback((id: string) => {
    setSidebar((s) => {
      const fix = (items: SidebarItem[]) =>
        items.some((i) => i.id === id && (i.unread || i.mentions))
          ? items.map((i) => (i.id === id ? { ...i, unread: 0, mentions: 0 } : i))
          : items;
      const channels = fix(s.channels);
      const conversations = fix(s.conversations);
      return channels === s.channels && conversations === s.conversations ? s : { ...s, channels, conversations };
    });
  }, [setSidebar]);

  const sendMark = useCallback((id: string, upTo: string | undefined) => {
    lastMark.current = { id, at: Date.now() };
    tracked(markRead(id, upTo)).catch(() => undefined);
  }, []);

  /** Send the batched mark now (leaving the channel, hiding the tab). */
  const flushMark = useCallback(() => {
    const p = markTimer.current;
    if (!p) return;
    clearTimeout(p.t);
    markTimer.current = null;
    sendMark(p.id, p.upTo);
  }, [sendMark]);

  /**
   * Tell the server what's been read. Opening a conversation reads it (the
   * "new" line stays where it was); after that the cursor only moves while
   * the reader is at the bottom, with the window focused. Scrolled up, or on
   * a second screen, it just says "here" every minute (so this conversation
   * doesn't ring their bell) and leaves the unread where it is.
   */
  const markSeen = useCallback(
    (force = false) => {
      const p = payloadRef.current;
      const id = p?.channel?.id;
      if (!id || !p?.channel || p.channel.moderatorView) return;
      if (!onScreen()) return;
      // Focus gates the cursor, not "still here": a conversation left open on
      // a second screen is still being watched, so no bell for it.
      const focused = document.hasFocus();
      let newest: string | undefined;
      for (const m of messagesRef.current) {
        if (localOnly(m)) continue;
        if (!newest || isAfter(m.createdAt, newest)) newest = m.createdAt;
      }
      const read = readUpTo.current.get(id);
      const advance =
        !!newest && (force || (focused && nearBottomRef.current && !hasMoreAfterRef.current)) && (!read || isAfter(newest, read));
      const sameChannel = lastMark.current.id === id;
      if (!sameChannel) flushMark();
      if (advance && newest) {
        readUpTo.current.set(id, newest);
        clearBadge(id);
        const pending = markTimer.current;
        const wait = sameChannel && !force ? lastMark.current.at + MARK_EVERY_MS - Date.now() : 0;
        if (wait <= 0) {
          if (pending) clearTimeout(pending.t);
          markTimer.current = null;
          sendMark(id, newest);
        } else if (pending && pending.id === id) {
          pending.upTo = newest;
        } else {
          markTimer.current = { id, upTo: newest, t: setTimeout(() => flushMark(), wait) };
        }
        return;
      }
      if (force) {
        if (!markTimer.current) sendMark(id, read ?? newest);
        return;
      }
      if (!sameChannel || Date.now() - lastMark.current.at >= PRESENCE_MS) {
        // "Still here": the cursor stays put (markRead never moves it back).
        if (!markTimer.current) sendMark(id, read ?? p.cursor);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearBadge, flushMark, sendMark],
  );

  // Opening a conversation (or showing its pane, on a phone) reads it.
  const paneShown = wide || mobilePane === "channel";
  useEffect(() => {
    if (channelId && paneShown) markSeen(true);
  }, [channelId, paneShown, markSeen]);

  // ---------------------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------------------

  const lastSidebarAt = useRef(Date.now());
  const refreshSidebar = useCallback(async () => {
    lastSidebarAt.current = Date.now();
    try {
      const next = await chatApi.sidebar();
      // The open channel is being read right now: don't flash a badge on it.
      const open = channelIdRef.current;
      const reading = onScreen() && document.hasFocus() && nearBottomRef.current;
      const patch = (items: SidebarItem[]) => items.map((i) => (i.id === open && reading ? { ...i, unread: 0, mentions: 0 } : i));
      const prev = sidebarRef.current;
      setSidebar({ ...next, channels: patch(next.channels), conversations: patch(next.conversations) });
      addPeople(next.people);
      // The open channel just left the sidebar (archived, removed from it,
      // access gone): find out what it is now rather than keep a stale
      // composer that fails every send.
      const all = (s: SidebarData) => [...s.channels, ...s.conversations];
      if (open && all(prev).some((i) => i.id === open) && !all(next).some((i) => i.id === open)) {
        void refreshOpen(open, { quiet: true });
      }
    } catch {
      /* keep what we have; the next tick retries */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addPeople, setSidebar]);

  // A bell: refetch the sidebar, a moment later (one @everyone bells every
  // online account at once), and once for a burst.
  const pingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  usePing(viewer.id, (type) => {
    if (pingTimer.current) return;
    pingTimer.current = setTimeout(() => {
      pingTimer.current = null;
      void refreshSidebar();
    }, pingDelay(type));
  });
  useEffect(() => () => {
    if (pingTimer.current) clearTimeout(pingTimer.current);
  }, []);

  // ---------------------------------------------------------------------------
  // Opening channels
  // ---------------------------------------------------------------------------

  const urlFor = (p: ChannelPayload) =>
    (p.channel ? `/chat?c=${p.channel.id}` : p.draftTo ? `/chat?to=${p.draftTo.id}` : "/chat") +
    (p.channel && p.focusId ? `&m=${p.focusId}` : "");

  /**
   * Show a fresh payload. Unsent and failed bubbles that belong to it ride
   * along: on screen now (the same channel, or the draft that just became
   * it), or kept with its cached copy. Reopening the channel already on
   * screen merges the fresh page into what's loaded instead of replacing it,
   * so its scroll position and older pages survive.
   */
  const adopt = useCallback(
    (p: ChannelPayload, since: number) => {
      // Answered after a link out of chat: that page owns the address bar now.
      if (!alive.current) return;
      const cur = payloadRef.current;
      const id = p.channel?.id ?? null;
      const same =
        !!id &&
        (cur?.channel?.id === id ||
          (!cur?.channel && !!cur?.draftTo && p.channel?.kind === "dm" && p.channel.otherId === cur.draftTo.id));
      const local = Array.from(
        new Map(
          [...(same ? messagesRef.current : []), ...((id && cache.current.get(id)?.messages) || [])]
            .filter(localOnly)
            .map((m) => [m.id, m]),
        ).values(),
      );
      const onScreenNow = same && !p.focusId && cur?.channel?.id === id ? messagesRef.current.filter((m) => !localOnly(m)) : [];
      const page = freshen(p.messages as UiMessage[], since, onScreenNow);
      // Merge only when the page meets what's loaded; a page from after a
      // long absence would leave a silent gap, so it replaces instead.
      let newestLoaded: string | null = null;
      for (const m of onScreenNow) if (!newestLoaded || isAfter(m.createdAt, newestLoaded)) newestLoaded = m.createdAt;
      const oldestOfPage = page[0]?.createdAt ?? null;
      const continuous =
        onScreenNow.length > 0 && (!p.hasMoreBefore || !oldestOfPage || !newestLoaded || !isAfter(oldestOfPage, newestLoaded));
      setPayload(p);
      const guard = { deleted: deleted.current };
      setMessages(mergeMessages(local, continuous ? mergeMessages(onScreenNow, page, guard) : page, guard));
      setHasMoreBefore(continuous ? hasMoreBeforeRef.current : p.hasMoreBefore);
      addPeople(p.people);
      setJumpTo(p.focusId);
      if (id) cache.current.delete(id);
      writeChatUrl(urlFor(p));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addPeople, freshen, setMessages, setPayload],
  );

  /** A cached copy, brought up to date with what this tab knows happened since. */
  const showCached = useCallback(
    (id: string, c: Cached) => {
      const info = c.payload.channel!;
      const now = Date.now();
      const sent = lastSentAt.current.get(id);
      const ownWait = info.kind === "channel" && !viewer.staff && sent ? Math.ceil(info.slowmodeSeconds - (now - sent) / 1000) : 0;
      const wait = Math.max(0, Math.ceil(info.slowmodeWait - (now - c.at) / 1000), ownWait);
      const read = readUpTo.current.get(id);
      setPayload({
        ...c.payload,
        cursor: read && isAfter(read, c.payload.cursor) ? read : c.payload.cursor,
        focusId: null,
        hasMoreAfter: false,
        channel: { ...info, slowmodeWait: wait },
      });
      setMessages(c.messages);
      setHasMoreBefore(c.hasMoreBefore);
      setJumpTo(null);
    },
    [setMessages, setPayload, viewer.staff],
  );

  /**
   * Did a failed read mean "not yours to see" (it's gone, or access is), or
   * a failure worth retrying? fetchChannel throws for both, so a channel's
   * own GET route (a 404 for "not available") settles it.
   */
  const isGone = async (err: unknown, id: string | null): Promise<boolean> => {
    if (err instanceof ChatReadError) return err.gone;
    if (!serverSaidNo(err)) return false;
    if (!id) return true;
    try {
      await chatApi.messages(id);
      return false;
    } catch (e) {
      return e instanceof ChatReadError && e.gone;
    }
  };

  const labelFor = (target: ChannelTarget): string => {
    const items = [...sidebarRef.current.channels, ...sidebarRef.current.conversations];
    if ("channelId" in target) return items.find((i) => i.id === target.channelId)?.label ?? "";
    if ("withUserId" in target) return peopleRef.current[target.withUserId]?.name ?? "";
    if ("teamId" in target) return items.find((i) => i.teamId === target.teamId)?.label ?? "";
    return items.find((i) => i.systemKey === target.systemKey)?.label ?? "";
  };

  // Each open gets a number; an answer for an older one is dropped, so a
  // slow fetch can't land on top of the channel the person switched to.
  const openSeq = useRef(0);
  /** Did this tab push a history entry for the conversation pane (a phone, from the list)? */
  const pushedPane = useRef(false);

  const openTarget = useCallback(
    async (target: ChannelTarget, how: { fromHistory?: boolean } = {}) => {
      const seq = ++openSeq.current;
      setError(null);
      // A phone opening a conversation from the list gets a history entry, so
      // Back (and Android's back gesture) returns to the list, not out of chat.
      const push =
        !how.fromHistory && mobilePaneRef.current === "list" && !window.matchMedia("(min-width: 768px)").matches;
      if (push) pushedPane.current = true;
      setMobilePane("channel");
      const cur = payloadRef.current;
      const id = "channelId" in target ? target.channelId : null;
      const around = "channelId" in target ? (target.around ?? null) : null;
      // Already open: nothing to fetch.
      const alreadyOpen =
        (!!id && !around && id === channelIdRef.current) ||
        ("withUserId" in target &&
          (cur?.channel ? cur.channel.kind === "dm" && cur.channel.otherId === target.withUserId : cur?.draftTo?.id === target.withUserId));
      if (alreadyOpen && cur) {
        setLoading(false);
        setOpening(null);
        if (!how.fromHistory) writeChatUrl(urlFor({ ...cur, focusId: null }), { push });
        return;
      }
      const sameChannel = !!id && id === channelIdRef.current;
      if (!sameChannel) stash();
      const cached = id && !around ? cache.current.get(id) : undefined;
      if (cached) {
        showCached(id!, cached);
        setLoading(false);
        setOpening(null);
      } else if (!sameChannel) {
        // Show the target loading, not the last conversation with a live
        // composer that would send there.
        setPayload(null);
        setMessages([]);
        setHasMoreBefore(false);
        setJumpTo(null);
        setOpening(labelFor(target));
        setLoading(true);
      }
      if (!how.fromHistory) {
        const url =
          "channelId" in target
            ? `/chat?c=${target.channelId}${around ? `&m=${around}` : ""}`
            : "withUserId" in target
              ? `/chat?to=${target.withUserId}`
              : null;
        if (url) writeChatUrl(url, { push });
      }
      const since = Date.now();
      try {
        const fresh = await tracked(fetchChannel(target));
        // Switched again while this was in flight.
        if (seq !== openSeq.current) return;
        if (!fresh) throw new ChatReadError(true);
        adopt(fresh, since);
        // What arrived while it sat in the cache is read now too.
        if (cached) markSeen(true);
      } catch (err) {
        if (seq !== openSeq.current) return;
        const gone = await isGone(err, id);
        if (seq !== openSeq.current) return;
        setError(gone ? NOT_AVAILABLE : READ_FAILED);
        if (gone && id) cache.current.delete(id);
        // A cached copy stays up through a blip; a jump inside the open
        // channel keeps it on screen either way.
        if (!sameChannel && (gone || !cached)) {
          setPayload(null);
          setMessages([]);
        }
      } finally {
        if (seq === openSeq.current) {
          setLoading(false);
          setOpening(null);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adopt, markSeen, setMessages, setPayload, showCached, stash],
  );

  /** Narrower than this, the side panel covers the conversation. */
  const panelCovers = () => !window.matchMedia("(min-width: 1024px)").matches;

  const openChannel = useCallback(
    (channelId: string, around?: string | null) => {
      // The panel covers the thread below lg: get it out of the way, or the
      // jump (and its highlight) happens out of sight.
      if (panelCovers()) setPanel(null);
      void openTarget({ channelId, around: around ?? null });
    },
    [openTarget],
  );

  const goToConversationWith = useCallback(
    (userId: string) => {
      if (userId === viewer.id) return;
      if (panelCovers()) setPanel(null);
      void openTarget({ withUserId: userId });
    },
    [openTarget, viewer.id],
  );

  // Back/forward between the list and a conversation (phones), or between
  // conversations this tab pushed.
  useEffect(() => {
    const onPop = () => {
      const sp = new URLSearchParams(window.location.search);
      const c = sp.get("c");
      const to = sp.get("to");
      if (!c && !to) {
        pushedPane.current = false;
        setMobilePane("list");
        return;
      }
      if (c && c === channelIdRef.current) {
        setMobilePane("channel");
        return;
      }
      if (c) void openTarget({ channelId: c, around: sp.get("m") }, { fromHistory: true });
      else if (to) void openTarget({ withUserId: to }, { fromHistory: true });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [openTarget]);

  const backToList = useCallback(() => {
    if (dropQueuedPush()) pushedPane.current = false;
    if (pushedPane.current) {
      // Undo our own entry: the popstate above shows the list.
      window.history.back();
      return;
    }
    setMobilePane("list");
    writeChatUrl("/chat");
  }, []);

  // Ctrl/Cmd+K: the quick switcher — not on top of another dialog.
  const switcherOpenRef = useRef(switcherOpen);
  switcherOpenRef.current = switcherOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      if (!switcherOpenRef.current && document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      setSwitcherOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------------------------------------------------------------------------
  // Keeping the open channel current
  // ---------------------------------------------------------------------------

  /** Reconcile the open channel with the server's newest page (deletes Realtime couldn't deliver, missed inserts). */
  const resync = useCallback(async () => {
    const id = channelIdRef.current;
    if (!id || hasMoreAfterRef.current) return;
    const since = Date.now();
    try {
      const page = await chatApi.messages(id);
      if (channelIdRef.current !== id || hasMoreAfterRef.current) return;
      addPeople(page.people);
      setMessages((prev) => {
        const fresh = freshen(page.messages as UiMessage[], since, prev);
        const next = reconcilePage(prev, fresh, { asOf: page.asOf, complete: !page.hasMoreBefore, deleted: deleted.current });
        // Unsent and failed bubbles are only ever on this screen: whatever
        // the server says, they stay until sent or discarded — or until the
        // page shows the message went in after all (its client id, 0104).
        const lost = prev.filter((m) => localOnly(m) && !next.includes(m) && !settledBy(m, next));
        return lost.length ? mergeMessages(next, lost) : next;
      });
    } catch {
      /* the next tick retries */
    }
  }, [addPeople, freshen, setMessages]);

  const refreshOpenRef = useRef<(id: string, opts?: { quiet?: boolean }) => Promise<void>>(async () => undefined);
  const refreshOpen = (id: string, opts?: { quiet?: boolean }) => refreshOpenRef.current(id, opts);

  // One tick while visible: the newest page, the sidebar, and "still here".
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void resync();
      void refreshSidebar();
      markSeen();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        flushMark();
        return;
      }
      markSeen();
      // Back after a while: catch up now rather than at the next tick.
      if (Date.now() - lastSidebarAt.current > 15_000) {
        void resync();
        void refreshSidebar();
      }
    };
    // Focus moves the read cursor (a visible but unfocused window doesn't),
    // and costs nothing else.
    const onFocus = () => markSeen();
    const onHide = () => flushMark();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onHide);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onHide);
      flushMark();
    };
  }, [flushMark, markSeen, refreshSidebar, resync]);

  const loadOlder = useCallback(async () => {
    const id = channelIdRef.current;
    const oldest = messagesRef.current.find((m) => !localOnly(m));
    if (!id || !oldest || loadingOlder) return;
    setLoadingOlder(true);
    const since = Date.now();
    try {
      const page = await chatApi.messages(id, { before: { createdAt: oldest.createdAt, id: oldest.id } });
      if (channelIdRef.current !== id) return;
      addPeople(page.people);
      setMessages((prev) => mergeMessages(prev, freshen(page.messages as UiMessage[], since, prev), { deleted: deleted.current }));
      setHasMoreBefore(page.hasMoreBefore);
    } catch {
      /* the button stays; try again */
    } finally {
      setLoadingOlder(false);
    }
  }, [addPeople, freshen, loadingOlder, setMessages]);

  /** Inserts skipped while reading a jump window: the newest page may have missed them. */
  const skippedLive = useRef(false);
  /** Leave a jump target's window for the newest page. */
  const presentSeq = useRef(0);
  const jumpToPresent = useCallback(async () => {
    const id = channelIdRef.current;
    if (!id) return;
    const seq = ++presentSeq.current;
    skippedLive.current = false;
    const since = Date.now();
    try {
      const page = await chatApi.messages(id);
      if (!alive.current || channelIdRef.current !== id || seq !== presentSeq.current) return;
      addPeople(page.people);
      setMessages((prev) => mergeMessages(prev.filter(localOnly), freshen(page.messages as UiMessage[], since, prev), { deleted: deleted.current }));
      setHasMoreBefore(page.hasMoreBefore);
      setPayload((p) => (p?.channel?.id === id ? { ...p, hasMoreAfter: false, focusId: null } : p));
      writeChatUrl(`/chat?c=${id}`);
      // Something arrived while that page was on its way: it may not be in it.
      if (skippedLive.current) {
        skippedLive.current = false;
        void resync();
      }
    } catch {
      if (channelIdRef.current === id) setError("Couldn't load the latest messages. Try again.");
    }
  }, [addPeople, freshen, resync, setMessages, setPayload]);

  // Mounted: the address bar is the chat's. Gone (a link out of chat, with a
  // channel still loading): every answer still on its way is for nobody, and
  // mustn't rewrite the next page's URL with a /chat one.
  useEffect(() => {
    alive.current = true;
    const release = holdChatUrl();
    return () => {
      alive.current = false;
      openSeq.current++;
      presentSeq.current++;
      release();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Live
  // ---------------------------------------------------------------------------

  const hydrate = useCallback(
    async (cid: string, ids: string[]) => {
      const since = Date.now();
      try {
        const res = await chatApi.messagesById(cid, ids);
        addPeople(res.people);
        if (channelIdRef.current === cid) {
          setMessages((prev) => mergeMessages(prev, freshen(res.messages as UiMessage[], since, prev), { deleted: deleted.current }));
        }
      } catch {
        /* resync will catch it */
      }
    },
    [addPeople, freshen, setMessages],
  );

  /**
   * Patch the open conversation's sidebar row: recency, preview, badge.
   * True when it isn't in the sidebar at all (refetch it then; only then).
   */
  const bumpSidebar = useCallback(
    (row: LiveRow, reading: boolean) => {
      const { sidebar: next, missing } = bumpSidebarRow(sidebarRef.current, row, {
        viewerId: viewer.id,
        reading,
        personName: (id) => peopleRef.current[id]?.name,
      });
      setSidebar(next);
      return missing;
    },
    [setSidebar, viewer.id],
  );

  const onInsert = useCallback(
    (row: LiveRow) => {
      if (!row?.id || deleted.current.has(row.id)) return;
      const isOpen = row.channel_id === channelIdRef.current;
      const fromOther = row.sender_id !== viewer.id;
      if (isOpen && hasMoreAfterRef.current) {
        // Reading old messages: the newest page will bring this in.
        skippedLive.current = true;
      } else if (isOpen) {
        const msg = toUiMessage(row, messagesRef.current);
        setMessages((prev) => {
          if (prev.some((m) => m.id === row.id)) return prev;
          // Our own echo can beat the send's reply, or come after it failed.
          // It carries the composer's client id (0104), and the merge settles
          // the bubble it is, sending or failed. Without one (before 0104),
          // adopt the bubble still sending with the same words.
          const i = pendingTwin(prev, row, viewer.id);
          if (i !== -1) {
            const next = [...prev];
            next.splice(i, 1);
            return mergeMessages(next, [msg]);
          }
          return mergeMessages(prev, [msg]);
        });
        // Sitting at the bottom of a busy channel: let the oldest go.
        const list = messagesRef.current;
        if (nearBottomRef.current && list.length > LIVE_TRIM_AT) {
          const from = list.length - LIVE_MAX;
          setMessages(list.filter((m, i) => i >= from || localOnly(m)));
          setHasMoreBefore(true);
        }
        const unknownSender = !!row.sender_id && !peopleRef.current[row.sender_id];
        const unknownReply = !!row.reply_to_id && !messagesRef.current.some((m) => m.id === row.reply_to_id);
        const unknownMention = (row.mentions ?? []).some((id) => !peopleRef.current[id]);
        if (unknownSender || unknownReply || unknownMention) void hydrate(row.channel_id, [row.id]);
        // markSeen reads messagesRef (current already) and batches the call.
        if (fromOther) markSeen();
      } else {
        const cached = cache.current.get(row.channel_id);
        if (cached) cached.messages = mergeMessages(cached.messages, [toUiMessage(row, cached.messages)]);
      }
      const reading = isOpen && onScreen() && document.hasFocus() && nearBottomRef.current;
      // A closed DM coming back, or one we've never seen: fetch the sidebar.
      if (bumpSidebar(row, reading)) void refreshSidebar();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bumpSidebar, hydrate, markSeen, refreshSidebar, setMessages, viewer.id],
  );

  /** A message's pin changed (live, or our own toggle): its flag, and the channel's pin count. */
  const setPinned = useCallback(
    (cid: string, before: UiMessage | undefined, pinnedAt: string | null, deletedNow = false) => {
      const was = !!before?.pinnedAt;
      const now = deletedNow ? false : !!pinnedAt;
      if (!before || was === now) return;
      const delta = now ? 1 : -1;
      if (channelIdRef.current === cid) setPayload((p) => (p ? { ...p, pins: Math.max(0, p.pins + delta) } : p));
      else {
        const c = cache.current.get(cid);
        if (c) c.payload = { ...c.payload, pins: Math.max(0, c.payload.pins + delta) };
      }
    },
    [setPayload],
  );

  const onUpdate = useCallback(
    (row: LiveRow) => {
      if (!row?.id) return;
      touch(row.id);
      if (row.deleted_at) deleted.current.add(row.id);
      const pinChange = has(row, "pinned_at") || !!row.deleted_at;
      if (row.channel_id === channelIdRef.current) {
        const before = messagesRef.current.find((m) => m.id === row.id);
        setMessages((prev) => applyUpdate(prev, row));
        if (pinChange) setPinned(row.channel_id, before, row.pinned_at ?? null, !!row.deleted_at);
        // The DM's sidebar row shows its newest message: follow an edit, and
        // refetch after a delete (what's newest now isn't known here).
        const item = sidebarRef.current.conversations.find((i) => i.id === row.channel_id);
        if (item && item.lastMessageAt === row.created_at) {
          if (row.deleted_at) void refreshSidebar();
          else if (typeof row.body === "string") {
            const preview = plainText(row.body || "[attachment]", (id) => peopleRef.current[id]?.name, () => null, 80);
            setSidebar((s) => ({
              ...s,
              conversations: s.conversations.map((i) => (i.id === row.channel_id ? { ...i, preview } : i)),
            }));
          }
        }
      } else {
        const cached = cache.current.get(row.channel_id);
        if (cached) {
          const before = cached.messages.find((m) => m.id === row.id);
          cached.messages = applyUpdate(cached.messages, row);
          if (pinChange) setPinned(row.channel_id, before, row.pinned_at ?? null, !!row.deleted_at);
        }
      }
    },
    [refreshSidebar, setMessages, setPinned, setSidebar, touch],
  );

  const connectedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useMessageFeed(channelId, {
    onInsert,
    onUpdate,
    // A (re)join: whatever happened while the socket was away, or between
    // the page load and the join, comes in now.
    onConnected: () => {
      if (connectedTimer.current) return;
      connectedTimer.current = setTimeout(() => {
        connectedTimer.current = null;
        void resync();
      }, 250);
    },
  });

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  /**
   * Apply a change to whichever list holds this message now: the one on
   * screen, or a cached channel's (the person switched away meanwhile).
   */
  const applyWhereItIs = useCallback(
    (id: string, fn: (list: UiMessage[]) => UiMessage[]) => {
      if (messagesRef.current.some((m) => m.id === id)) {
        setMessages(fn);
        return;
      }
      for (const c of cache.current.values()) {
        if (c.messages.some((m) => m.id === id)) c.messages = fn(c.messages);
      }
    },
    [setMessages],
  );

  const refreshOpenStable = useCallback(
    async (id: string, opts: { quiet?: boolean } = {}) => {
      if (!id) return;
      // Changed while the person was elsewhere: refetch it when it's next opened.
      if (id !== channelIdRef.current) {
        cache.current.delete(id);
        return;
      }
      const seq = openSeq.current;
      const still = () => seq === openSeq.current && channelIdRef.current === id;
      const since = Date.now();
      try {
        const fresh = await tracked(fetchChannel({ channelId: id }));
        if (!still()) return;
        if (!fresh) throw new ChatReadError(true);
        adopt(fresh, since);
      } catch (err) {
        if (!still()) return;
        const gone = await isGone(err, id);
        if (!still()) return;
        if (gone) {
          cache.current.delete(id);
          setPayload(null);
          setMessages([]);
          setError(NOT_AVAILABLE);
        } else if (!opts.quiet) {
          // A blip: keep the conversation, say the change may not show yet.
          setError(READ_FAILED);
        }
      }
    },
    [adopt, setMessages, setPayload],
  );
  refreshOpenRef.current = refreshOpenStable;

  type SendInput = {
    body: string;
    reply: Reply | null;
    attachments: { path: string; name: string; size: number; type: string }[];
    /** Made once when the message is written; every Retry sends it again (0104). */
    clientId: string;
  };

  const sendWith = useCallback(
    async (input: SendInput) => {
      const p = payloadRef.current;
      if (!p) return;
      stopTyping();
      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const cid0 = p.channel?.id ?? null;
      const retry = {
        body: input.body,
        replyToId: input.reply?.id ?? null,
        attachments: input.attachments.map((a) => ({ path: a.path, name: a.name })),
        clientId: input.clientId,
      };
      const optimistic: UiMessage = {
        id: tempId,
        channelId: cid0 ?? "",
        senderId: viewer.id,
        body: input.body,
        kind: "message",
        replyTo: input.reply ? { ...input.reply, deleted: false } : null,
        mentions: [],
        mentionEveryone: false,
        attachments: input.attachments,
        reactions: {},
        createdAt: new Date().toISOString(),
        editedAt: null,
        pinnedAt: null,
        clientId: input.clientId,
        pending: true,
        retry,
      };
      setMessages((prev) => [...prev, optimistic]);
      nearBottomRef.current = true;
      if (cid0) lastSentAt.current.set(cid0, Date.now());
      // Writing from a jump target's window: the message belongs at the
      // present, so go there (the bubble rides along as pending).
      if (p.channel && hasMoreAfterRef.current) void jumpToPresent();

      const res = await tracked(
        sendMessage({
          channelId: p.channel?.id,
          toUserId: p.channel ? undefined : p.draftTo?.id,
          body: input.body,
          replyToId: retry.replyToId,
          attachments: retry.attachments,
          clientId: input.clientId,
        }),
      ).catch(() => ({ ok: false as const, error: OFFLINE }));
      // The answer belongs to the bubble wherever it is now: on screen, or
      // with the channel's cached copy if the person switched away. (Gone
      // already: its echo or a resync brought the message itself.)
      if (!res.ok || !res.data) {
        const why = resultError(res, "Couldn't send. Try again.");
        applyWhereItIs(tempId, (prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: why } : m)));
        // Refused for a reason the header should know about (archived, blocked,
        // slow mode): refresh what this conversation allows.
        if (why !== OFFLINE && cid0 && channelIdRef.current === cid0) void refreshOpenRef.current(cid0, { quiet: true });
        return;
      }
      const { message, channelId: cid } = res.data;
      lastSentAt.current.set(cid, Date.now());
      applyWhereItIs(tempId, (prev) => mergeMessages(prev.filter((m) => m.id !== tempId), [message as UiMessage]));
      // It names someone this tab has no name for (picked some other way than
      // the "@" menu): fetch the message with its people, or it says "@unknown".
      if (message.mentions.some((id) => !peopleRef.current[id])) void hydrate(cid, [message.id]);
      if (!p.channel) {
        // A draft's first message created the DM: become that channel — but
        // only if the person is still on the draft (or already on the DM).
        const cur = payloadRef.current;
        if (cur && !cur.channel && cur.draftTo?.id === p.draftTo?.id) {
          const since = Date.now();
          try {
            const fresh = await tracked(fetchChannel({ channelId: cid }));
            const now = payloadRef.current;
            if (fresh && now && !now.channel && now.draftTo?.id === p.draftTo?.id) adopt(fresh, since);
          } catch {
            /* the sidebar refresh below still shows it */
          }
        }
        void refreshSidebar();
      }
      if (channelIdRef.current === cid && onScreen()) {
        readUpTo.current.set(cid, message.createdAt);
        lastMark.current = { id: cid, at: Date.now() };
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adopt, applyWhereItIs, hydrate, jumpToPresent, refreshSidebar, setMessages, stopTyping, viewer.id],
  );

  // A new message from the composer gets its own client id here, once.
  const send = useCallback(
    (input: { body: string; replyTo: UiMessage | null; attachments: SendInput["attachments"] }) =>
      void sendWith({
        body: input.body,
        reply: input.replyTo ? toQuote(input.replyTo) : null,
        attachments: input.attachments,
        clientId: newClientId(),
      }),
    [sendWith],
  );

  const retrySend = useCallback(
    (m: UiMessage) => {
      if (!m.retry) return;
      const retry = m.retry;
      setMessages((prev) => prev.filter((x) => x.id !== m.id));
      // The quote it was sent with, whether or not the original is still loaded.
      const reply = retry.replyToId ? (m.replyTo?.id === retry.replyToId ? m.replyTo : { id: retry.replyToId, senderId: null, preview: "", deleted: false }) : null;
      const sizes = new Map(m.attachments.map((a) => [a.path, a]));
      void sendWith({
        body: retry.body,
        reply,
        attachments: retry.attachments.map((a) => ({ ...a, size: sizes.get(a.path)?.size ?? 0, type: sizes.get(a.path)?.type ?? "" })),
        // The same message, so the same id: if the first try went in after
        // all, the server hands that one back rather than posting it again.
        clientId: retry.clientId,
      });
    },
    [sendWith, setMessages],
  );

  const discard = useCallback((id: string) => setMessages((prev) => prev.filter((m) => m.id !== id)), [setMessages]);

  const edit = useCallback(
    async (id: string, body: string): Promise<string | null> => {
      const res = await tracked(editMessage(id, body)).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!res.ok) return resultError(res, "Couldn't save that edit.");
      const updated = res.data?.message;
      if (updated) {
        touch(id);
        applyWhereItIs(id, (prev) => applyUpdate(prev, {
          id,
          channel_id: updated.channelId,
          sender_id: updated.senderId,
          kind: updated.kind,
          reply_to_id: updated.replyTo?.id ?? null,
          created_at: updated.createdAt,
          body: updated.body,
          edited_at: updated.editedAt,
          mentions: updated.mentions,
          mention_everyone: updated.mentionEveryone,
        }));
      }
      return null;
    },
    [applyWhereItIs, touch],
  );

  const remove = useCallback(
    async (id: string): Promise<string | null> => {
      const res = await tracked(deleteMessage(id)).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!res.ok) return resultError(res, "Couldn't delete that message.");
      deleted.current.add(id);
      touch(id);
      const cid = channelIdRef.current;
      const before = messagesRef.current.find((m) => m.id === id);
      applyWhereItIs(id, (prev) => withoutMessage(prev, id));
      if (cid && before) setPinned(cid, before, null, true);
      return null;
    },
    [applyWhereItIs, setPinned, touch],
  );

  const react = useCallback(
    async (id: string, emoji: string) => {
      const before = messagesRef.current.find((m) => m.id === id)?.reactions ?? {};
      const optimistic = applyToggle(before, emoji, viewer.id);
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reactions: optimistic } : m)));
      const started = Date.now();
      const res = await tracked(toggleReaction(id, emoji)).catch(() => ({ ok: false as const, error: OFFLINE }));
      // A live update for this message landed meanwhile: it's the server's
      // newer word on its reactions (ours included, if it went through).
      const newer = (touched.current.get(id) ?? 0) >= started;
      if (res.ok && res.data) {
        if (newer) return;
        const reactions = res.data.reactions;
        touch(id);
        applyWhereItIs(id, (prev) => prev.map((m) => (m.id === id ? { ...m, reactions } : m)));
      } else {
        // Undo the optimistic toggle — unless something newer already replaced it.
        applyWhereItIs(id, (prev) => prev.map((m) => (m.id === id && m.reactions === optimistic ? { ...m, reactions: before } : m)));
        setError(resultError(res, "Couldn't react."));
      }
    },
    [applyWhereItIs, setMessages, touch, viewer.id],
  );

  const pin = useCallback(
    async (id: string) => {
      const cid = channelIdRef.current;
      const started = Date.now();
      const res = await tracked(togglePin(id)).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!res.ok) {
        if (channelIdRef.current === cid) setError(resultError(res, "Couldn't pin that."));
        return;
      }
      // The live update got here first and did all of this already.
      if (!cid || (touched.current.get(id) ?? 0) >= started) return;
      touch(id);
      const pinnedAt = res.data?.pinned ? new Date().toISOString() : null;
      const list = channelIdRef.current === cid ? messagesRef.current : (cache.current.get(cid)?.messages ?? []);
      setPinned(cid, list.find((m) => m.id === id), pinnedAt);
      applyWhereItIs(id, (prev) => prev.map((m) => (m.id === id ? { ...m, pinnedAt } : m)));
    },
    [applyWhereItIs, setPinned, touch],
  );

  const onMarkAllRead = useCallback(async () => {
    const res = await tracked(markAllRead()).catch(() => ({ ok: false as const, error: OFFLINE }));
    if (res.ok) {
      setSidebar((s) => ({
        ...s,
        channels: s.channels.map((c) => ({ ...c, unread: 0, mentions: 0 })),
        conversations: s.conversations.map((c) => ({ ...c, unread: 0, mentions: 0 })),
      }));
      return;
    }
    // It may have got halfway (everything read, the bells still up): show
    // what the server has now, not what this tab assumed.
    setError(resultError(res, "Couldn't mark everything read. Try again."));
    void refreshSidebar();
  }, [refreshSidebar, setSidebar]);

  // Names for #channel chips. Same names, same map: a sidebar poll that
  // changes nothing mustn't re-render every message.
  const channelNamesKey = sidebar.channels.map((c) => `${c.id}:${c.label}`).join("|");
  const channelNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of sidebarRef.current.channels) m.set(c.id, c.label);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelNamesKey]);

  const onChannelChanged = useCallback(
    (id: string) => {
      void refreshSidebar();
      void refreshOpenRef.current(id);
    },
    [refreshSidebar],
  );

  const onLeft = useCallback(
    async (id: string) => {
      cache.current.delete(id);
      if (channelIdRef.current === id) {
        setPayload(null);
        setMessages([]);
        if (dropQueuedPush()) pushedPane.current = false;
        if (pushedPane.current) window.history.back();
        else {
          setMobilePane("list");
          writeChatUrl("/chat");
        }
      }
      await refreshSidebar();
    },
    [refreshSidebar, setMessages, setPayload],
  );

  const wasDeleted = useCallback((id: string) => deleted.current.has(id), []);

  // The members panel is for channels and groups.
  const shownPanel: Panel = panel === "members" && payload?.channel?.kind === "dm" ? null : panel;

  return (
    <div className="flex h-full min-h-0 w-full">
      <div
        className={`${mobilePane === "list" ? "flex" : "hidden"} w-full shrink-0 flex-col border-line md:flex md:w-72 md:border-r`}
      >
        <ChatSidebar
          viewer={viewer}
          home={home}
          homeLabel={homeLabel}
          sidebar={sidebar}
          people={people}
          online={online}
          activeId={channelId}
          draftTo={payload && !payload.channel ? payload.draftTo : null}
          onOpen={(id) => openChannel(id)}
          onNew={() => setNewOpen(true)}
          onSwitcher={() => setSwitcherOpen(true)}
          onMarkAllRead={onMarkAllRead}
          onChanged={refreshSidebar}
        />
      </div>

      <div className={`${mobilePane === "channel" ? "flex" : "hidden"} min-w-0 flex-1 flex-col md:flex`}>
        <ChannelView
          viewer={viewer}
          payload={payload}
          messages={messages}
          people={people}
          online={online}
          channelNames={channelNames}
          loading={loading}
          opening={opening}
          error={error}
          onDismissError={() => setError(null)}
          typingIds={typing}
          onTyping={notifyTyping}
          hasMoreBefore={hasMoreBefore}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlder}
          hasMoreAfter={!!payload?.channel && !!payload.hasMoreAfter}
          onJumpToPresent={jumpToPresent}
          jumpTo={jumpTo}
          onJumped={() => setJumpTo(null)}
          onBack={backToList}
          panel={shownPanel}
          onPanel={(p) => setPanel((cur) => (cur === p ? null : p))}
          onSend={send}
          onRetry={retrySend}
          onDiscard={discard}
          onEdit={edit}
          onDelete={remove}
          onReact={react}
          onPin={pin}
          onOpenChannel={openChannel}
          onMessagePerson={goToConversationWith}
          onNearBottom={(near) => {
            const was = nearBottomRef.current;
            nearBottomRef.current = near;
            if (near && !was) markSeen();
          }}
          onChannelChanged={onChannelChanged}
          blocked={sidebar.blocked}
          onBlocksChanged={refreshSidebar}
          onLeft={onLeft}
          wasDeleted={wasDeleted}
          onPeople={addPeople}
        />
      </div>

      {shownPanel && payload?.channel ? (
        <SidePanel
          panel={shownPanel}
          viewer={viewer}
          channel={payload.channel}
          people={people}
          online={online}
          channelNames={channelNames}
          onClose={() => setPanel(null)}
          onJump={(cid, mid) => openChannel(cid, mid)}
          onMessagePerson={goToConversationWith}
          addPeople={addPeople}
        />
      ) : null}

      <NewConversationDialog
        open={newOpen}
        viewer={viewer}
        self={people[viewer.id] ?? null}
        onClose={() => setNewOpen(false)}
        onOpenDraft={(userId) => {
          setNewOpen(false);
          goToConversationWith(userId);
        }}
        onOpenChannel={async (id) => {
          setNewOpen(false);
          await refreshSidebar();
          openChannel(id);
        }}
      />

      <QuickSwitcher
        open={switcherOpen}
        sidebar={sidebar}
        onClose={() => setSwitcherOpen(false)}
        onOpen={(id) => {
          setSwitcherOpen(false);
          openChannel(id);
        }}
      />
    </div>
  );
}
