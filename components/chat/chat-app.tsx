"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAfter, toggleReaction as applyToggle } from "@/lib/chat-access";
import { plainText } from "@/lib/chat-format";
import { mentionsViewer, mergeMessages, reconcilePage } from "@/lib/chat-view";
import type { ChatAttachment } from "@/lib/chat-files-rules";
import type { ChannelTarget } from "@/lib/chat-payload";
import {
  deleteMessage,
  editMessage,
  fetchChannel,
  fetchMessages,
  fetchMessagesById,
  fetchSidebar,
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
import { useMessageFeed, usePing, usePresence, useTyping, type LiveRow } from "./use-chat-live";
import type { ChatPerson, ChannelPayload, ChatViewerInfo, Panel, SidebarData, SidebarItem, UiMessage } from "./types";
import { resultError } from "./util";

/**
 * batch0 Chat, the client. Owns the sidebar, the open channel, a small cache
 * of recently opened channels (so switching back is instant), and the live
 * feed. Every read and write goes through app/chat/actions.ts, which re-checks
 * everything; nothing here is a security boundary.
 */

const RESYNC_MS = 20_000;
const SIDEBAR_POLL_MS = 30_000;
const PRESENCE_MS = 60_000;
const CACHE_MAX = 12;

type Cached = { payload: ChannelPayload; messages: UiMessage[] };

function toUiMessage(row: LiveRow, known: readonly UiMessage[]): UiMessage {
  const reply = row.reply_to_id ? known.find((m) => m.id === row.reply_to_id) : null;
  return {
    id: row.id,
    channelId: row.channel_id,
    senderId: row.sender_id,
    body: row.body ?? "",
    kind: row.kind ?? "message",
    replyTo: row.reply_to_id
      ? reply
        ? { id: reply.id, senderId: reply.senderId, preview: reply.body.slice(0, 300), deleted: false }
        : { id: row.reply_to_id, senderId: null, preview: "", deleted: false }
      : null,
    mentions: row.mentions ?? [],
    mentionEveryone: !!row.mention_everyone,
    attachments: (Array.isArray(row.attachments) ? row.attachments : []) as ChatAttachment[],
    reactions: row.reactions ?? {},
    createdAt: row.created_at,
    editedAt: row.edited_at,
    pinnedAt: row.pinned_at,
  };
}

/** Drop a deleted message, and blank every reply quote that carried its words. */
function withoutMessage(list: UiMessage[], id: string): UiMessage[] {
  const quoted = list.some((m) => m.replyTo?.id === id && !m.replyTo.deleted);
  if (!quoted && !list.some((m) => m.id === id)) return list;
  return list
    .filter((m) => m.id !== id)
    .map((m) => (m.replyTo?.id === id ? { ...m, replyTo: { ...m.replyTo, preview: "", deleted: true } } : m));
}

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
  const [sidebar, setSidebar] = useState(initialSidebar);
  const [payload, setPayload] = useState<ChannelPayload | null>(initialPayload);
  const [messages, setMessages] = useState<UiMessage[]>(initialPayload?.messages ?? []);
  const [people, setPeople] = useState<Record<string, ChatPerson>>(() => ({
    ...initialSidebar.people,
    ...(initialPayload?.people ?? {}),
  }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [panel, setPanel] = useState<Panel>(null);
  const [mobilePane, setMobilePane] = useState<"list" | "channel">(initialPayload ? "channel" : "list");
  const [newOpen, setNewOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [jumpTo, setJumpTo] = useState<string | null>(initialPayload?.focusId ?? null);
  const [hasMoreBefore, setHasMoreBefore] = useState(initialPayload?.hasMoreBefore ?? false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const online = usePresence(viewer.id);
  const channelId = payload?.channel?.id ?? null;
  const { typing, notify: notifyTyping, stop: stopTyping } = useTyping(channelId, viewer.id);

  const cache = useRef(new Map<string, Cached>());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  // Reading a window around a jump target, newer messages not loaded: live
  // inserts and resyncs would land after it with a silent gap in between.
  const hasMoreAfter = !!payload?.channel && !!payload.hasMoreAfter;
  const hasMoreAfterRef = useRef(hasMoreAfter);
  hasMoreAfterRef.current = hasMoreAfter;
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const nearBottomRef = useRef(true);

  const addPeople = useCallback((more: Record<string, ChatPerson> | undefined) => {
    if (!more || Object.keys(more).length === 0) return;
    setPeople((prev) => {
      let changed = false;
      for (const id of Object.keys(more)) if (prev[id] !== more[id]) changed = true;
      return changed ? { ...prev, ...more } : prev;
    });
  }, []);

  // Keep the open channel's cache entry current.
  useEffect(() => {
    if (!payload?.channel) return;
    const c = cache.current;
    c.delete(payload.channel.id);
    c.set(payload.channel.id, { payload, messages });
    while (c.size > CACHE_MAX) c.delete(c.keys().next().value as string);
  }, [payload, messages]);

  // ---------------------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------------------

  const refreshSidebar = useCallback(async () => {
    try {
      const next = await fetchSidebar();
      // The open channel is being read right now: don't flash a badge on it.
      const open = channelIdRef.current;
      const patch = (items: SidebarItem[]) =>
        items.map((i) => (i.id === open && document.visibilityState === "visible" && nearBottomRef.current ? { ...i, unread: 0, mentions: 0 } : i));
      setSidebar({ ...next, channels: patch(next.channels), conversations: patch(next.conversations) });
      addPeople(next.people);
    } catch {
      /* keep what we have; the next tick retries */
    }
  }, [addPeople]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refreshSidebar();
    }, SIDEBAR_POLL_MS);
    return () => clearInterval(t);
  }, [refreshSidebar]);

  usePing(viewer.id, () => void refreshSidebar());

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
  }, []);

  // ---------------------------------------------------------------------------
  // Opening channels
  // ---------------------------------------------------------------------------

  const urlFor = (p: ChannelPayload) =>
    p.channel ? `/chat?c=${p.channel.id}` : p.draftTo ? `/chat?to=${p.draftTo.id}` : "/chat";

  const adopt = useCallback(
    (p: ChannelPayload, opts: { keepPending?: boolean } = {}) => {
      setPayload(p);
      setMessages((prev) => {
        const pending = opts.keepPending ? prev.filter((m) => m.pending || m.failed) : [];
        return mergeMessages(p.messages as UiMessage[], pending);
      });
      setHasMoreBefore(p.hasMoreBefore);
      addPeople(p.people);
      setJumpTo(p.focusId);
      window.history.replaceState(null, "", urlFor(p) + (p.focusId ? `&m=${p.focusId}` : ""));
    },
    [addPeople],
  );

  // Each open gets a number; an answer for an older one is dropped, so a
  // slow fetch can't land on top of the channel the person switched to.
  const openSeq = useRef(0);
  const openTarget = useCallback(
    async (target: ChannelTarget) => {
      const seq = ++openSeq.current;
      setError(null);
      setMobilePane("channel");
      const id = "channelId" in target ? target.channelId : null;
      const around = "channelId" in target ? (target.around ?? null) : null;
      if (id && !around && id === channelIdRef.current) return;
      const cached = id && !around ? cache.current.get(id) : undefined;
      if (cached) {
        setPayload(cached.payload);
        setMessages(cached.messages);
        setHasMoreBefore(cached.payload.hasMoreBefore);
        setJumpTo(null);
        window.history.replaceState(null, "", `/chat?c=${id}`);
      } else {
        setLoading(true);
      }
      try {
        const fresh = await fetchChannel(target);
        // Switched again while this was in flight.
        if (seq !== openSeq.current) return;
        // Coming back to a cached channel keeps its unsent and failed bubbles
        // (with their Retry) on top of the fresh page.
        adopt(fresh, { keepPending: !!cached });
      } catch (err) {
        if (seq !== openSeq.current) return;
        setError(err instanceof Error ? err.message : "That channel isn't available.");
        if (!cached) setPayload(null);
      } finally {
        if (seq === openSeq.current) setLoading(false);
      }
    },
    [adopt],
  );

  const openChannel = useCallback((channelId: string, around?: string | null) => {
    void openTarget({ channelId, around: around ?? null });
    // On a phone the panel is a full-screen sheet over the thread: get it out
    // of the way, or the jump (and its highlight) happens out of sight.
    if (typeof window !== "undefined" && !window.matchMedia("(min-width: 768px)").matches) setPanel(null);
  }, [openTarget]);

  // Ctrl/Cmd+K: the quick switcher.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  const lastMark = useRef<{ id: string | null; upTo: string | undefined; at: number }>({ id: null, upTo: undefined, at: 0 });
  const markSeen = useCallback(
    (force = false) => {
      const p = payloadRef.current;
      const id = p?.channel?.id;
      if (!id || p?.channel?.moderatorView) return;
      if (document.visibilityState !== "visible") return;
      let newest: string | undefined;
      for (const m of messagesRef.current) {
        if (m.pending || m.failed) continue;
        if (!newest || isAfter(m.createdAt, newest)) newest = m.createdAt;
      }
      const last = lastMark.current;
      const sameChannel = last.id === id;
      const newer = !!newest && (!sameChannel || !last.upTo || isAfter(newest, last.upTo));
      if (!force && !newer && sameChannel && Date.now() - last.at < PRESENCE_MS) return;
      lastMark.current = { id, upTo: newest ?? last.upTo, at: Date.now() };
      clearBadge(id);
      markRead(id, newest).catch(() => undefined);
    },
    [clearBadge],
  );

  useEffect(() => {
    if (channelId) markSeen(true);
  }, [channelId, markSeen]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      markSeen();
      void resync();
      void refreshSidebar();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void resync();
      markSeen();
    }, RESYNC_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markSeen, refreshSidebar]);

  /** Reconcile the open channel with the server's newest page (deletes Realtime can't deliver after a reconnect, missed inserts). */
  const resync = useCallback(async () => {
    const id = channelIdRef.current;
    if (!id || hasMoreAfterRef.current) return;
    try {
      const page = await fetchMessages(id);
      if (channelIdRef.current !== id || hasMoreAfterRef.current) return;
      addPeople(page.people);
      setMessages((prev) =>
        reconcilePage(prev, page.messages as UiMessage[], { asOf: page.asOf, complete: !page.hasMoreBefore }),
      );
    } catch {
      /* the next tick retries */
    }
  }, [addPeople]);

  const loadOlder = useCallback(async () => {
    const id = channelIdRef.current;
    const oldest = messagesRef.current.find((m) => !m.pending);
    if (!id || !oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await fetchMessages(id, { before: oldest.createdAt });
      if (channelIdRef.current !== id) return;
      addPeople(page.people);
      setMessages((prev) => mergeMessages(prev, page.messages as UiMessage[]));
      setHasMoreBefore(page.hasMoreBefore);
    } catch {
      /* the button stays; try again */
    } finally {
      setLoadingOlder(false);
    }
  }, [addPeople, loadingOlder]);

  /** Leave a jump target's window for the newest page. */
  const presentSeq = useRef(0);
  const jumpToPresent = useCallback(async () => {
    const id = channelIdRef.current;
    if (!id) return;
    const seq = ++presentSeq.current;
    try {
      const page = await fetchMessages(id);
      if (channelIdRef.current !== id || seq !== presentSeq.current) return;
      addPeople(page.people);
      setMessages((prev) => mergeMessages(page.messages as UiMessage[], prev.filter((m) => m.pending || m.failed)));
      setHasMoreBefore(page.hasMoreBefore);
      setPayload((p) => (p?.channel?.id === id ? { ...p, hasMoreAfter: false, focusId: null } : p));
      window.history.replaceState(null, "", `/chat?c=${id}`);
    } catch {
      if (channelIdRef.current === id) setError("Couldn't load the latest messages. Try again.");
    }
  }, [addPeople]);

  // ---------------------------------------------------------------------------
  // Live
  // ---------------------------------------------------------------------------

  const feedIds = useMemo(
    () => [...sidebar.channels.map((c) => c.id), ...sidebar.conversations.map((c) => c.id), ...(channelId ? [channelId] : [])],
    [sidebar.channels, sidebar.conversations, channelId],
  );

  const hydrate = useCallback(
    async (cid: string, ids: string[]) => {
      try {
        const res = await fetchMessagesById(cid, ids);
        addPeople(res.people);
        if (channelIdRef.current === cid) setMessages((prev) => mergeMessages(prev, res.messages as UiMessage[]));
      } catch {
        /* resync will catch it */
      }
    },
    [addPeople],
  );

  const onInsert = useCallback(
    (row: LiveRow) => {
      if (!row?.id) return;
      const isOpen = row.channel_id === channelIdRef.current;
      const fromOther = row.sender_id !== viewer.id;
      if (isOpen && hasMoreAfterRef.current) {
        // Reading old messages: the newest page will bring this in.
      } else if (isOpen) {
        const msg = toUiMessage(row, messagesRef.current);
        setMessages((prev) => {
          if (prev.some((m) => m.id === row.id)) return prev;
          // Our own echo can beat the send's reply: adopt the pending bubble.
          if (!fromOther) {
            const i = prev.findIndex((m) => m.pending && m.body === msg.body);
            if (i !== -1) {
              const next = [...prev];
              next.splice(i, 1);
              return mergeMessages(next, [msg]);
            }
          }
          return mergeMessages(prev, [msg]);
        });
        const unknownSender = !!row.sender_id && !peopleRef.current[row.sender_id];
        const unknownReply = !!row.reply_to_id && !messagesRef.current.some((m) => m.id === row.reply_to_id);
        const unknownMention = (row.mentions ?? []).some((id) => !peopleRef.current[id]);
        if (unknownSender || unknownReply || unknownMention) void hydrate(row.channel_id, [row.id]);
        if (fromOther && document.visibilityState === "visible" && nearBottomRef.current) {
          // markSeen reads messagesRef; give the state a tick to land.
          setTimeout(() => markSeen(), 50);
        }
      } else {
        const cached = cache.current.get(row.channel_id);
        if (cached) cached.messages = mergeMessages(cached.messages, [toUiMessage(row, cached.messages)]);
      }
      // Sidebar: recency, preview, and the badge.
      let missing = true;
      setSidebar((s) => {
        const bump = (items: SidebarItem[], isConversation: boolean) =>
          items.map((i) => {
            if (i.id !== row.channel_id) return i;
            missing = false;
            const counts = row.kind === "message" && fromOther && !(isOpen && document.visibilityState === "visible" && nearBottomRef.current);
            const mention = mentionsViewer(
              { mentions: row.mentions ?? [], mentionEveryone: row.mention_everyone, senderId: row.sender_id },
              viewer.id,
            );
            return {
              ...i,
              lastMessageAt: row.kind === "message" ? row.created_at : i.lastMessageAt,
              preview:
                isConversation && row.kind === "message"
                  ? plainText(row.body || "[attachment]", (id) => peopleRef.current[id]?.name, () => null, 80)
                  : i.preview,
              unread: counts ? Math.min(i.unread + 1, 100) : i.unread,
              mentions: counts && (isConversation || mention) ? Math.min(i.mentions + 1, 100) : i.mentions,
            };
          });
        const conversations = bump(s.conversations, true).sort((a, b) =>
          a.lastMessageAt && b.lastMessageAt ? (isAfter(a.lastMessageAt, b.lastMessageAt) ? -1 : 1) : a.lastMessageAt ? -1 : 1,
        );
        return { ...s, channels: bump(s.channels, false), conversations };
      });
      // A closed DM coming back, or one we've never seen: fetch the sidebar.
      setTimeout(() => {
        if (missing) void refreshSidebar();
      }, 0);
    },
    [hydrate, markSeen, refreshSidebar, viewer.id],
  );

  const onUpdate = useCallback((row: LiveRow) => {
    if (!row?.id) return;
    const apply = (list: UiMessage[]): UiMessage[] => {
      // A delete also takes its words out of every reply quoting it — even a
      // quote whose original isn't loaded.
      if (row.deleted_at) return withoutMessage(list, row.id);
      const i = list.findIndex((m) => m.id === row.id);
      if (i === -1) return list;
      const cur = list[i];
      const next: UiMessage = {
        ...cur,
        body: row.body ?? cur.body,
        editedAt: row.edited_at,
        mentions: row.mentions ?? cur.mentions,
        mentionEveryone: !!row.mention_everyone,
        reactions: row.reactions ?? {},
        pinnedAt: row.pinned_at,
        attachments: (Array.isArray(row.attachments) ? row.attachments : cur.attachments) as ChatAttachment[],
      };
      const copy = [...list];
      copy[i] = next;
      // A reply quoting this message follows its edits.
      return copy.map((m) =>
        m.replyTo?.id === row.id ? { ...m, replyTo: { ...m.replyTo, preview: row.body.slice(0, 300) } } : m,
      );
    };
    if (row.channel_id === channelIdRef.current) setMessages((prev) => apply(prev));
    const cached = cache.current.get(row.channel_id);
    if (cached) cached.messages = apply(cached.messages);
  }, []);

  useMessageFeed(feedIds, {
    onInsert,
    onUpdate,
    onConnected: () => {
      void resync();
    },
  });

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  const send = useCallback(
    async (input: { body: string; replyTo: UiMessage | null; attachments: { path: string; name: string; size: number; type: string }[] }) => {
      const p = payloadRef.current;
      if (!p) return;
      stopTyping();
      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const retry = {
        body: input.body,
        replyToId: input.replyTo?.id ?? null,
        attachments: input.attachments.map((a) => ({ path: a.path, name: a.name })),
      };
      const optimistic: UiMessage = {
        id: tempId,
        channelId: p.channel?.id ?? "",
        senderId: viewer.id,
        body: input.body,
        kind: "message",
        replyTo: input.replyTo
          ? { id: input.replyTo.id, senderId: input.replyTo.senderId, preview: input.replyTo.body.slice(0, 300), deleted: false }
          : null,
        mentions: [],
        mentionEveryone: false,
        attachments: input.attachments,
        reactions: {},
        createdAt: new Date().toISOString(),
        editedAt: null,
        pinnedAt: null,
        pending: true,
        retry,
      };
      setMessages((prev) => [...prev, optimistic]);
      nearBottomRef.current = true;
      // Writing from a jump target's window: the message belongs at the
      // present, so go there (the bubble rides along as pending).
      if (p.channel && hasMoreAfterRef.current) void jumpToPresent();

      // The answer belongs to the channel it was sent from, which may not be
      // the one open by the time it lands: apply it there, or to its cache.
      const cid0 = p.channel?.id ?? null;
      const seq0 = openSeq.current;
      const stillHere = () => (cid0 ? channelIdRef.current === cid0 : payloadRef.current === p && openSeq.current === seq0);
      const applyHere = (fn: (list: UiMessage[]) => UiMessage[]) => {
        if (stillHere()) setMessages(fn);
        else if (cid0) {
          const cached = cache.current.get(cid0);
          if (cached) cached.messages = fn(cached.messages);
        }
      };

      const res = await sendMessage({
        channelId: p.channel?.id,
        toUserId: p.channel ? undefined : p.draftTo?.id,
        body: input.body,
        replyToId: retry.replyToId,
        attachments: retry.attachments,
      }).catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : "Couldn't send. Try again." }));
      if (!res.ok || !res.data) {
        const why = resultError(res, "Couldn't send. Try again.");
        applyHere((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: why } : m)));
        return;
      }
      const { message, channelId: cid } = res.data;
      applyHere((prev) => mergeMessages(prev.filter((m) => m.id !== tempId), [message as UiMessage]));
      if (!p.channel) {
        // A draft's first message created the DM: become that channel — but
        // only if the person is still on the draft.
        if (stillHere()) {
          try {
            const fresh = await fetchChannel({ channelId: cid });
            if (stillHere()) adopt(fresh, { keepPending: true });
          } catch {
            /* the sidebar refresh below still shows it */
          }
        }
        void refreshSidebar();
      }
      lastMark.current = { id: cid, upTo: message.createdAt, at: Date.now() };
    },
    [adopt, jumpToPresent, refreshSidebar, stopTyping, viewer.id],
  );

  const retrySend = useCallback(
    (m: UiMessage) => {
      if (!m.retry) return;
      setMessages((prev) => prev.filter((x) => x.id !== m.id));
      const replyTo = m.retry.replyToId ? (messagesRef.current.find((x) => x.id === m.retry!.replyToId) ?? null) : null;
      void send({
        body: m.retry.body,
        replyTo,
        attachments: m.retry.attachments.map((a) => ({ ...a, size: 0, type: "" })),
      });
    },
    [send],
  );

  const discard = useCallback((id: string) => setMessages((prev) => prev.filter((m) => m.id !== id)), []);

  const edit = useCallback(async (id: string, body: string): Promise<string | null> => {
    const res = await editMessage(id, body);
    if (!res.ok) return resultError(res, "Couldn't save that edit.");
    const updated = res.data?.message;
    if (updated) setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...updated } : m)));
    return null;
  }, []);

  const remove = useCallback(async (id: string): Promise<string | null> => {
    const res = await deleteMessage(id);
    if (!res.ok) return resultError(res, "Couldn't delete that message.");
    setMessages((prev) => withoutMessage(prev, id));
    return null;
  }, []);

  const react = useCallback(
    async (id: string, emoji: string) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reactions: applyToggle(m.reactions, emoji, viewer.id) } : m)));
      const res = await toggleReaction(id, emoji);
      if (res.ok && res.data) {
        const reactions = res.data.reactions;
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reactions } : m)));
      } else {
        // Undo the optimistic toggle and say why.
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reactions: applyToggle(m.reactions, emoji, viewer.id) } : m)));
        setError(resultError(res, "Couldn't react."));
      }
    },
    [viewer.id],
  );

  const pin = useCallback(async (id: string) => {
    const res = await togglePin(id);
    if (!res.ok) {
      setError(resultError(res, "Couldn't pin that."));
      return;
    }
    const pinned = !!res.data?.pinned;
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pinnedAt: pinned ? new Date().toISOString() : null } : m)));
    setPayload((p) => (p ? { ...p, pins: Math.max(0, p.pins + (pinned ? 1 : -1)) } : p));
  }, []);

  const onMarkAllRead = useCallback(async () => {
    const res = await markAllRead();
    if (res.ok) {
      setSidebar((s) => ({
        ...s,
        channels: s.channels.map((c) => ({ ...c, unread: 0, mentions: 0 })),
        conversations: s.conversations.map((c) => ({ ...c, unread: 0, mentions: 0 })),
      }));
    }
  }, []);

  const channelNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of sidebar.channels) m.set(c.id, c.label);
    return m;
  }, [sidebar.channels]);

  const reloadChannel = useCallback(async () => {
    const id = channelIdRef.current;
    const seq = openSeq.current;
    // Only while the person is still on the channel that changed: a switch in
    // the meantime must not get yanked back (or blanked) by this answer.
    const still = () => seq === openSeq.current && channelIdRef.current === id;
    await refreshSidebar();
    if (!id || !still()) return;
    try {
      const fresh = await fetchChannel({ channelId: id });
      if (still()) adopt(fresh, { keepPending: true });
    } catch {
      if (!still()) return;
      setPayload(null);
      setMobilePane("list");
    }
  }, [adopt, refreshSidebar]);

  const goToConversationWith = useCallback((userId: string) => {
    if (userId === viewer.id) return;
    void openTarget({ withUserId: userId });
  }, [openTarget, viewer.id]);

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
          error={error}
          onDismissError={() => setError(null)}
          typingIds={typing}
          onTyping={notifyTyping}
          hasMoreBefore={hasMoreBefore}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlder}
          hasMoreAfter={hasMoreAfter}
          onJumpToPresent={jumpToPresent}
          jumpTo={jumpTo}
          onJumped={() => setJumpTo(null)}
          onBack={() => setMobilePane("list")}
          panel={panel}
          onPanel={(p) => setPanel((cur) => (cur === p ? null : p))}
          onSend={send}
          onRetry={retrySend}
          onDiscard={discard}
          onEdit={edit}
          onDelete={remove}
          onReact={react}
          onPin={pin}
          onOpenChannel={(id) => openChannel(id)}
          onMessagePerson={goToConversationWith}
          onNearBottom={(near) => {
            const was = nearBottomRef.current;
            nearBottomRef.current = near;
            if (near && !was) markSeen();
          }}
          onChannelChanged={reloadChannel}
          blocked={sidebar.blocked}
          onBlocksChanged={refreshSidebar}
          onLeft={async () => {
            setPayload(null);
            setMobilePane("list");
            window.history.replaceState(null, "", "/chat");
            await refreshSidebar();
          }}
        />
      </div>

      {panel && payload?.channel ? (
        <SidePanel
          panel={panel}
          viewer={viewer}
          channel={payload.channel}
          people={people}
          online={online}
          channelNames={channelNames}
          onClose={() => setPanel(null)}
          onJump={(cid, mid) => {
            openChannel(cid, mid);
          }}
          onMessagePerson={goToConversationWith}
          addPeople={addPeople}
        />
      ) : null}

      <NewConversationDialog
        open={newOpen}
        viewer={viewer}
        onClose={() => setNewOpen(false)}
        onOpenDraft={(userId) => {
          setNewOpen(false);
          void openTarget({ withUserId: userId });
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
