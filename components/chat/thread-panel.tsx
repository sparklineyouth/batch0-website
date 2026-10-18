"use client";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bell, BellOff, CheckCircle2, CircleHelp, LifeBuoy, Loader2, RotateCcw, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { toggleReaction as applyToggle } from "@/lib/chat-access";
import { plainText } from "@/lib/chat-format";
import { mergeMessages, reconcilePage } from "@/lib/chat-view";
import type { QuestionAction } from "@/lib/chat-threads-rules";
import type { ThreadInfo } from "@/lib/chat-threads";
import {
  deleteMessage,
  editMessage,
  followThread,
  markThreadSeen,
  sendMessage,
  setQuestion,
  toggleReaction,
  blockPerson,
  unblockPerson,
  type FlagResult,
} from "@/app/chat/actions";
import { Avatar, RoleTag } from "./avatar";
import { MessageMarkup, type MarkupContext } from "./markup";
import { AboutLink, Attachments, MessageList, QuestionBadge, type MessageActions } from "./message-list";
import { Composer } from "./composer";
import { FlagDialog, MuteDialog, ReportDeletedDialog, ReportDialog } from "./dialogs";
import { ChatReadError, NOT_AVAILABLE, READ_FAILED, chatApi, tracked } from "./api";
import { applyUpdate, localOnly, sameMessage, toUiMessage, withoutMessage } from "./live-rows";
import { OFFLINE, newClientId, resultError, senderName, stampLabel } from "./util";
import type { ThreadBus } from "./thread-bus";
import type { ChannelInfo, ChatPerson, ChatViewerInfo, UiMessage } from "./types";

const POLL_MS = 30_000;
const SEEN_MS = 60_000;

/** What the feed's copy of the root learns from the pane: its count and its question's state. */
export type RootPatch = Partial<NonNullable<UiMessage["thread"]>>;

/**
 * One thread (migration 0110), in Chat's side pane: the message it hangs
 * off, its replies, a composer for them, and — in #help — the question's
 * state and what the asker or the team can do with it. A column beside the
 * channel from lg up, a drawer over it on a tablet, and the whole screen on a
 * phone, with Back (SidePanel decides which; the channel stays mounted
 * underneath, so it's exactly where it was when the pane closes).
 *
 * Replies come from GET /chat/api/thread, a page at a time on the feed's
 * (createdAt, id) keyset, and live from ChatApp's one Realtime subscription
 * over the thread bus; every 30 seconds and on a reconnect it reconciles with
 * the newest page, so nothing is skipped or shown twice, and a page fetched
 * before a delete can't bring the reply back (`deleted`). A send carries
 * its client id (0104), so a Retry is the same reply.
 */
export function ThreadPanel({
  viewer,
  channel,
  rootId,
  focusId,
  people,
  online,
  channelNames,
  blocked,
  bus,
  deleted,
  onReplyDeleted,
  addPeople,
  onRootPatch,
  onReplySent,
  onClose,
  onMessagePerson,
  onOpenChannel,
  onBlocksChanged,
}: {
  viewer: ChatViewerInfo;
  channel: ChannelInfo;
  rootId: string;
  /** A reply to scroll to and flash on arrival (a bell, a search hit). */
  focusId: string | null;
  people: Record<string, ChatPerson>;
  online: Set<string>;
  channelNames: Map<string, string>;
  blocked: readonly string[];
  bus: ThreadBus;
  /** Ids this page has seen deleted (ChatApp's set): they stay gone whatever a page says. */
  deleted: ReadonlySet<string>;
  /** A reply this pane deleted: ChatApp counts it off the root, once. */
  onReplyDeleted: (rootId: string, replyId: string) => void;
  addPeople: (p: Record<string, ChatPerson>) => void;
  onRootPatch: (rootId: string, patch: RootPatch) => void;
  onReplySent: (rootId: string, reply: UiMessage) => void;
  onClose: () => void;
  onMessagePerson: (userId: string) => void;
  onOpenChannel: (id: string) => void;
  onBlocksChanged: () => void;
}) {
  const [root, setRoot] = useState<UiMessage | null>(null);
  const [rootGone, setRootGone] = useState(false);
  const [info, setInfo] = useState<ThreadInfo | null>(null);
  const [replies, setRepliesState] = useState<UiMessage[]>([]);
  const repliesRef = useRef<UiMessage[]>([]);
  const setReplies = useCallback((next: UiMessage[] | ((list: UiMessage[]) => UiMessage[])) => {
    const value = typeof next === "function" ? next(repliesRef.current) : next;
    if (value === repliesRef.current) return;
    repliesRef.current = value;
    setRepliesState(value);
  }, []);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const hasMoreRef = useRef(false);
  hasMoreRef.current = hasMoreBefore;
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [jumpTo, setJumpTo] = useState<string | null>(focusId);
  const [replyTo, setReplyTo] = useState<UiMessage | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UiMessage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [report, setReport] = useState<UiMessage | null>(null);
  const [reportDeleted, setReportDeleted] = useState<{ id: string; senderId: string } | null>(null);
  const [flagging, setFlagging] = useState<UiMessage | null>(null);
  const [muting, setMuting] = useState<{ userId: string; name: string } | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [members, setMembers] = useState<ChatPerson[]>([]);
  const touched = useRef(new Map<string, number>());
  const loadSeq = useRef(0);
  const rootRef = useRef(rootId);
  rootRef.current = rootId;
  const infoRef = useRef(info);
  infoRef.current = info;
  const ids = useId();
  const composerId = `${ids}-thread-composer`;
  const headingId = `${ids}-thread-heading`;
  const guard = useMemo(() => ({ deleted }), [deleted]);

  /** A page from the server, safe to merge: deleted replies stay out, a reply changed live since `since` keeps its copy. */
  const freshen = useCallback(
    (page: readonly UiMessage[], since: number, onScreen: readonly UiMessage[]) => {
      const byId = new Map(onScreen.map((m) => [m.id, m]));
      return page.filter((m) => !deleted.has(m.id)).map((m) => {
        const cur = byId.get(m.id);
        return cur && ((touched.current.get(m.id) ?? 0) >= since || sameMessage(cur, m)) ? cur : m;
      });
    },
    [deleted],
  );

  const adoptInfo = useCallback(
    (next: ThreadInfo, rootMessage: UiMessage | null) => {
      setInfo(next);
      onRootPatch(next.rootId, {
        question: next.question,
        answerId: next.answerId,
        ...(rootMessage?.thread ? { replyCount: rootMessage.thread.replyCount, lastReplyAt: rootMessage.thread.lastReplyAt } : {}),
      });
    },
    [onRootPatch],
  );

  /** The newest page: on open, every 30 seconds, after a reconnect. Reconciled, so a reply deleted meanwhile goes. */
  const refresh = useCallback(
    async (first = false) => {
      const n = ++loadSeq.current;
      const id = rootRef.current;
      const since = Date.now();
      if (first) {
        setLoading(true);
        setError(null);
      }
      try {
        const page = await chatApi.thread(channel.id, id);
        if (n !== loadSeq.current || id !== rootRef.current) return;
        addPeople(page.people);
        setRoot((page.root as UiMessage | null) ?? null);
        setRootGone(!page.root);
        adoptInfo(page.info, (page.root as UiMessage | null) ?? null);
        setReplies((prev) => {
          const fresh = freshen(page.replies as UiMessage[], since, prev);
          if (first) return mergeMessages(prev.filter(localOnly), fresh, guard);
          return reconcilePage(prev, fresh, { asOf: page.asOf, complete: !page.hasMoreBefore, ...guard });
        });
        if (first || !hasMoreRef.current) setHasMoreBefore(page.hasMoreBefore);
        setError(null);
      } catch (err) {
        if (n !== loadSeq.current) return;
        if (first || (err instanceof ChatReadError && err.gone)) {
          setError(err instanceof ChatReadError && err.gone ? NOT_AVAILABLE : READ_FAILED);
        }
      } finally {
        if (n === loadSeq.current && first) setLoading(false);
      }
    },
    [addPeople, adoptInfo, channel.id, freshen, guard, setReplies],
  );

  // A different thread: start over.
  useEffect(() => {
    repliesRef.current = [];
    setRepliesState([]);
    setRoot(null);
    setInfo(null);
    setHasMoreBefore(false);
    setReplyTo(null);
    setEditingId(null);
    setNotice(null);
    setJumpTo(focusId);
    void refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, channel.id]);

  useEffect(() => {
    if (focusId) setJumpTo(focusId);
  }, [focusId]);

  // Who the "@" menu offers first: the channel's readers.
  useEffect(() => {
    let live = true;
    chatApi
      .members(channel.id)
      .then((list) => live && setMembers(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [channel.id]);

  /** Fetch replies Realtime brought without everything their row needs (a name, a quote). */
  const hydrate = useCallback(
    async (messageIds: string[]) => {
      const since = Date.now();
      try {
        const res = await chatApi.messagesById(channel.id, messageIds);
        addPeople(res.people);
        const mine = (res.messages as UiMessage[]).filter((m) => m.threadRootId === rootRef.current);
        setReplies((prev) => mergeMessages(prev, freshen(mine, since, prev), guard));
      } catch {
        /* the next refresh brings them */
      }
    },
    [addPeople, channel.id, freshen, guard, setReplies],
  );

  // "Still here": the thread's bells wait, and the ones up come down.
  useEffect(() => {
    if (channel.moderatorView) return;
    const seen = () => {
      if (document.visibilityState === "visible") void tracked(markThreadSeen(channel.id, rootId)).catch(() => undefined);
    };
    seen();
    const t = setInterval(seen, SEEN_MS);
    return () => clearInterval(t);
  }, [channel.id, channel.moderatorView, rootId]);

  // Live: replies and edits from the open channel's feed, and a resync on reconnect.
  useEffect(
    () =>
      bus.subscribe((e) => {
        if (e.kind === "resync") {
          void refresh();
          return;
        }
        const row = e.row;
        if (e.kind === "insert") {
          if (row.thread_root_id !== rootRef.current || deleted.has(row.id)) return;
          const msg = toUiMessage(row, repliesRef.current);
          setReplies((prev) => (prev.some((m) => m.id === row.id) ? prev : mergeMessages(prev, [msg], guard)));
          const unknown =
            (!!row.sender_id && !people[row.sender_id]) ||
            (!!row.reply_to_id && !repliesRef.current.some((m) => m.id === row.reply_to_id) && row.reply_to_id !== rootRef.current) ||
            (row.mentions ?? []).some((id) => !people[id]);
          if (unknown) void hydrate([row.id]);
          return;
        }
        touched.current.set(row.id, Date.now());
        if (row.thread_root_id === rootRef.current) {
          setReplies((prev) => applyUpdate(prev, row));
          // The accepted answer was deleted: 0110 has already reopened the question.
          if (row.deleted_at && infoRef.current?.answerId === row.id) {
            setInfo((i) => (i ? { ...i, question: "open", answerId: null } : i));
          }
        } else if (row.id === rootRef.current) {
          if (row.deleted_at) {
            setRoot(null);
            setRootGone(true);
            setInfo((i) => (i ? { ...i, question: null, answerId: null } : i));
          } else setRoot((r) => (r ? (applyUpdate([r], row)[0] ?? r) : r));
        }
      }),
    [bus, deleted, guard, hydrate, people, refresh, setReplies],
  );

  // Every 30 seconds while visible, like the channel.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const loadOlder = useCallback(async () => {
    const oldest = repliesRef.current.find((m) => !localOnly(m));
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    const since = Date.now();
    try {
      const page = await chatApi.thread(channel.id, rootId, { before: { createdAt: oldest.createdAt, id: oldest.id } });
      if (rootRef.current !== rootId) return;
      addPeople(page.people);
      setReplies((prev) => mergeMessages(prev, freshen(page.replies as UiMessage[], since, prev), guard));
      setHasMoreBefore(page.hasMoreBefore);
    } catch {
      /* the button stays */
    } finally {
      setLoadingOlder(false);
    }
  }, [addPeople, channel.id, freshen, guard, loadingOlder, rootId, setReplies]);

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  type Outgoing = {
    body: string;
    replyTo: UiMessage | { id: string; senderId: string | null; preview: string; deleted: boolean } | null;
    attachments: { path: string; name: string; size: number; type: string }[];
    clientId: string;
  };

  const sendWith = useCallback(
    async (input: Outgoing) => {
      const id = rootRef.current;
      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const quote = input.replyTo
        ? "kind" in input.replyTo
          ? { id: input.replyTo.id, senderId: input.replyTo.senderId, preview: input.replyTo.body, deleted: false }
          : input.replyTo
        : null;
      const retry = {
        body: input.body,
        replyToId: quote?.id ?? null,
        attachments: input.attachments.map((a) => ({ path: a.path, name: a.name })),
        clientId: input.clientId,
        threadRootId: id,
      };
      const optimistic: UiMessage = {
        id: tempId,
        channelId: channel.id,
        senderId: viewer.id,
        body: input.body,
        kind: "message",
        replyTo: quote,
        mentions: [],
        mentionEveryone: false,
        attachments: input.attachments,
        reactions: {},
        createdAt: new Date().toISOString(),
        editedAt: null,
        pinnedAt: null,
        clientId: input.clientId,
        threadRootId: id,
        pending: true,
        retry,
      };
      setReplies((prev) => [...prev, optimistic]);
      const res = await tracked(
        sendMessage({
          channelId: channel.id,
          body: input.body,
          replyToId: retry.replyToId,
          attachments: retry.attachments,
          clientId: input.clientId,
          threadRootId: id,
        }),
      ).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!res.ok || !res.data) {
        const why = resultError(res, "Couldn't send. Try again.");
        setReplies((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: why } : m)));
        return;
      }
      const message = res.data.message as UiMessage;
      setReplies((prev) => mergeMessages(prev.filter((m) => m.id !== tempId), [message], guard));
      onReplySent(id, message);
      if (message.mentions.some((m) => !people[m])) void hydrate([message.id]);
      // Replying makes you a follower (0110) unless you unfollowed on purpose: ask.
      if (infoRef.current && !infoRef.current.following) void refresh();
    },
    [channel.id, guard, hydrate, onReplySent, people, refresh, setReplies, viewer.id],
  );

  const send = useCallback(
    (input: { body: string; replyTo: UiMessage | null; attachments: Outgoing["attachments"] }) =>
      void sendWith({ ...input, clientId: newClientId() }),
    [sendWith],
  );

  const retrySend = useCallback(
    (m: UiMessage) => {
      if (!m.retry) return;
      const retry = m.retry;
      setReplies((prev) => prev.filter((x) => x.id !== m.id));
      const sizes = new Map(m.attachments.map((a) => [a.path, a]));
      void sendWith({
        body: retry.body,
        replyTo: retry.replyToId ? (m.replyTo ?? { id: retry.replyToId, senderId: null, preview: "", deleted: false }) : null,
        attachments: retry.attachments.map((a) => ({ ...a, size: sizes.get(a.path)?.size ?? 0, type: sizes.get(a.path)?.type ?? "" })),
        // The same reply, so the same id: one that went through comes back, not twice.
        clientId: retry.clientId,
      });
    },
    [sendWith, setReplies],
  );

  const edit = useCallback(
    async (id: string, body: string): Promise<string | null> => {
      const res = await tracked(editMessage(id, body)).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!res.ok) return resultError(res, "Couldn't save that edit.");
      const updated = res.data?.message as UiMessage | undefined;
      if (updated) {
        touched.current.set(id, Date.now());
        setReplies((prev) => prev.map((m) => (m.id === id ? { ...m, ...updated } : m)));
      }
      return null;
    },
    [setReplies],
  );

  const remove = useCallback(
    async (id: string): Promise<string | null> => {
      const res = await tracked(deleteMessage(id)).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!res.ok) return resultError(res, "Couldn't delete that message.");
      touched.current.set(id, Date.now());
      onReplyDeleted(rootRef.current, id);
      setReplies((prev) => withoutMessage(prev, id));
      if (infoRef.current?.answerId === id) setInfo((i) => (i ? { ...i, question: "open", answerId: null } : i));
      return null;
    },
    [onReplyDeleted, setReplies],
  );

  const react = useCallback(
    async (id: string, emoji: string) => {
      const before = repliesRef.current.find((m) => m.id === id)?.reactions ?? {};
      const optimistic = applyToggle(before, emoji, viewer.id);
      setReplies((prev) => prev.map((m) => (m.id === id ? { ...m, reactions: optimistic } : m)));
      const started = Date.now();
      const res = await tracked(toggleReaction(id, emoji)).catch(() => ({ ok: false as const, error: OFFLINE }));
      if ((touched.current.get(id) ?? 0) >= started && res.ok) return;
      if (res.ok && res.data) {
        const reactions = res.data.reactions;
        setReplies((prev) => prev.map((m) => (m.id === id ? { ...m, reactions } : m)));
      } else {
        setReplies((prev) => prev.map((m) => (m.id === id && m.reactions === optimistic ? { ...m, reactions: before } : m)));
        setNotice(resultError(res, "Couldn't react."));
      }
    },
    [setReplies, viewer.id],
  );

  const toggleBlock = useCallback(
    async (userId: string) => {
      const isBlocked = blocked.includes(userId);
      const res = await tracked(isBlocked ? unblockPerson(userId) : blockPerson(userId)).catch(() => ({ ok: false as const, error: OFFLINE }));
      setNotice(res.ok ? (isBlocked ? "Unblocked." : "Blocked. They aren't told.") : resultError(res, "Couldn't do that."));
      if (res.ok) onBlocksChanged();
    },
    [blocked, onBlocksChanged],
  );

  /** Settle the question (#help): accept a reply, mark it answered, reopen it, or say it isn't one. */
  const decide = useCallback(
    async (action: QuestionAction, answer: UiMessage | null = null) => {
      const now = infoRef.current;
      if (!now || deciding) return;
      setDeciding(true);
      const res = await tracked(
        setQuestion({ rootId: now.rootId, action, answerId: answer?.id ?? null, expect: { question: now.question, answerId: now.answerId } }),
      ).catch(() => ({ ok: false as const, error: OFFLINE }));
      setDeciding(false);
      if (!res.ok || !res.data) {
        setNotice(resultError(res, "Couldn't update the question."));
        void refresh();
        return;
      }
      adoptInfo(res.data.info, null);
      setNotice(
        action === "accept"
          ? "Answer accepted. The question shows as answered."
          : action === "mark_answered"
            ? "Marked answered."
            : action === "reopen"
              ? "Reopened. It's back in Unanswered."
              : action === "unmark"
                ? "It's not a question any more."
                : "It's a question now, in Unanswered.",
      );
    },
    [adoptInfo, deciding, refresh],
  );

  const toggleFollow = useCallback(async () => {
    const now = infoRef.current;
    if (!now) return;
    const next = !now.following;
    setInfo((i) => (i ? { ...i, following: next } : i));
    const res = await tracked(followThread(now.rootId, next)).catch(() => ({ ok: false as const, error: OFFLINE }));
    if (!res.ok) {
      setInfo((i) => (i ? { ...i, following: !next } : i));
      setNotice(resultError(res, "Couldn't save that."));
      return;
    }
    setNotice(next ? "Following: new replies ring your bell." : "Unfollowed: replies here won't ring unless someone @mentions you.");
  }, []);

  const actions: MessageActions = useMemo(
    () => ({
      onReply: (m) => setReplyTo(m),
      onEdit: edit,
      onDelete: (m) => setConfirmDelete(m),
      onReact: (id, emoji) => void react(id, emoji),
      onPin: () => undefined,
      onReport: (m) => setReport(m),
      onReportDeleted: (id, senderId) => setReportDeleted({ id, senderId }),
      onBlock: (id) => void toggleBlock(id),
      onRetry: retrySend,
      onDiscard: (id) => setReplies((prev) => prev.filter((m) => m.id !== id)),
      onMessagePerson,
      onFlag: (m) => setFlagging(m),
      onMute: (userId, name) => setMuting({ userId, name }),
      onAccept: (m) => void decide("accept", m),
    }),
    [decide, edit, onMessagePerson, react, retrySend, setReplies, toggleBlock],
  );

  const markup: MarkupContext = useMemo(
    () => ({
      viewerId: viewer.id,
      personName: (id) => people[id]?.name ?? members.find((m) => m.id === id)?.name ?? null,
      channelName: (id) => channelNames.get(id) ?? null,
      onMention: (id) => onMessagePerson(id),
      onChannel: (id) => onOpenChannel(id),
    }),
    [viewer.id, people, members, channelNames, onMessagePerson, onOpenChannel],
  );

  const candidates = useMemo(() => members.filter((m) => m.id !== viewer.id), [members, viewer.id]);
  const editLast = () => {
    const mine = [...replies].reverse().find((m) => m.senderId === viewer.id && !localOnly(m) && m.kind === "message");
    if (mine && !channel.archived) setEditingId(mine.id);
  };

  const disabledReason = channel.moderatorView
    ? "You're reading this as a moderator."
    : rootGone
      ? "The message that started this thread was deleted. It takes no new replies."
      : channel.compose.ok
        ? null
        : channel.compose.reason;
  const answer = info?.answerId ? replies.find((m) => m.id === info.answerId) : undefined;
  const replyCount = root?.thread?.replyCount ?? replies.filter((m) => !localOnly(m)).length;

  const lead = (
    <div className="mx-4 mb-4 md:mx-5">
      <div className="rounded-md border border-line bg-wash/40 p-3">
        {root ? (
          <>
            <div className="flex items-center gap-2">
              <Avatar name={senderName(root, people)} online={!!root.senderId && online.has(root.senderId)} size={28} />
              <span className="min-w-0 truncate text-sm font-semibold text-ink">{senderName(root, people)}</span>
              <RoleTag person={root.senderId ? people[root.senderId] : null} />
              <time dateTime={root.createdAt} className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
                {stampLabel(root.createdAt)}
              </time>
            </div>
            <div className="mt-1.5 text-[15px] leading-relaxed text-ink">
              {root.body ? <MessageMarkup body={root.body} ctx={markup} /> : null}
              {root.editedAt ? <span className="ml-1 text-[10px] text-ink-faint">(edited)</span> : null}
            </div>
            {root.attachments.length > 0 ? <Attachments m={root} tab={0} /> : null}
          </>
        ) : loading ? (
          <div className="flex justify-center py-2">
            <Loader2 className="h-4 w-4 animate-spin text-ink-faint" aria-label="Loading" />
          </div>
        ) : (
          <p className="text-sm italic text-ink-faint">The message that started this thread was deleted.</p>
        )}
        {info?.about ? (
          <div className="mt-2">
            <AboutLink about={info.about} />
          </div>
        ) : null}
        {info ? (
          <QuestionControls
            info={info}
            hasRoot={!!root}
            busy={deciding}
            answer={answer ?? null}
            people={people}
            onDecide={(a) => void decide(a)}
            onJump={(id) => setJumpTo(id)}
          />
        ) : null}
        {info?.help ? <HelpLine help={info.help} /> : null}
      </div>
      <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint" aria-live="polite">
        {replyCount === 0 ? "No replies yet" : `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`}
      </p>
    </div>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        // Escape from the thread's composer (nothing of its own to cancel) leaves the pane.
        if (e.key === "Escape" && !e.defaultPrevented && (e.target as HTMLElement).id === composerId) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-2.5 pt-[calc(0.625rem+var(--safe-top))] md:px-4 md:pt-3">
        <button
          type="button"
          onClick={onClose}
          aria-label={`Back to #${channel.label}`}
          className="rounded-md p-1.5 text-ink-soft hover:bg-wash md:hidden"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="font-display text-2xl leading-none text-ink">
            Thread
          </h2>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">#{channel.label}</p>
        </div>
        {info && !channel.moderatorView ? (
          <button
            type="button"
            onClick={() => void toggleFollow()}
            aria-pressed={info.following}
            title={info.following ? "Unfollow: no bells for new replies" : "Follow: a bell for new replies"}
            className={`inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-xs ${info.following ? "bg-wash text-ink" : "text-ink-soft hover:bg-wash hover:text-ink"}`}
          >
            {info.following ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
            {info.following ? "Following" : "Follow"}
          </button>
        ) : null}
        {root && !channel.moderatorView ? (
          <button
            type="button"
            onClick={() => setFlagging(root)}
            aria-label="Ask the team for help with this thread"
            title="Ask the team for help"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-soft hover:bg-wash hover:text-ink"
          >
            <LifeBuoy className="h-4 w-4" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close thread"
          className="hidden h-9 w-9 items-center justify-center rounded-md text-ink-faint hover:bg-wash hover:text-ink md:inline-flex"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {error ? (
        <p className="border-b border-red-500/30 bg-red-500/5 px-4 py-2 text-xs text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <div className="flex items-start gap-2 border-b border-line bg-wash px-4 py-2 text-xs text-ink-soft" role="status">
          <span className="min-w-0 flex-1 break-words">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 rounded hover:bg-paper">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {error === NOT_AVAILABLE ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-ink-soft">
          This thread isn&apos;t available. It may have been removed, or you may not be in its channel any more.
        </div>
      ) : (
        <MessageList
          viewer={viewer}
          channel={channel}
          messages={replies}
          people={people}
          online={online}
          blocked={blocked}
          cursor={null}
          markup={markup}
          hasMoreBefore={hasMoreBefore}
          loadingOlder={loadingOlder}
          onLoadOlder={() => void loadOlder()}
          jumpTo={jumpTo}
          onJumped={() => setJumpTo(null)}
          editingId={editingId}
          setEditingId={setEditingId}
          actions={actions}
          onNearBottom={() => undefined}
          emptyHint={
            // The list puts this above its first message: only for a thread with none.
            loading || replies.length > 0 ? null : (
              <p className="text-sm text-ink-soft">
                {rootGone ? "Nobody replied before it was deleted." : "No replies yet. Start the thread below."}
              </p>
            )
          }
          lead={lead}
          thread={{ answerId: info?.answerId ?? null, canAccept: !!info?.canDecide && info.question !== null }}
          composerId={composerId}
          listKey={`thread:${rootId}`}
          label="Replies"
        />
      )}

      {channel.moderatorView ? null : (
        <Composer
          channelId={channel.id}
          placeholder="Reply in thread"
          disabledReason={disabledReason}
          slowmodeWait={0}
          slowmodeSeconds={channel.kind === "channel" && !viewer.staff ? channel.slowmodeSeconds : 0}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          people={people}
          candidates={candidates}
          onSend={send}
          onTyping={() => undefined}
          onEditLast={editLast}
          canMentionEveryone={false}
          draftKey={`thread:${rootId}`}
          selfId={viewer.id}
          onPeople={addPeople}
          inputId={composerId}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete?.senderId === viewer.id ? "Delete this reply?" : "Remove this reply?"}
        description={
          confirmDelete?.senderId === viewer.id
            ? "It disappears for everyone. The batch0 team can still see what it said if it's ever reported."
            : "It disappears for everyone, and the removal is logged."
        }
        confirmLabel={confirmDelete?.senderId === viewer.id ? "Delete" : "Remove"}
        destructive
        pending={deleting}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (!confirmDelete || deleting) return;
          setDeleting(true);
          let err: string | null;
          try {
            err = await remove(confirmDelete.id);
          } catch {
            err = OFFLINE;
          } finally {
            setDeleting(false);
          }
          setConfirmDelete(null);
          if (err) setNotice(err);
        }}
      />
      {report ? (
        <ReportDialog
          channel={channel}
          message={report}
          people={people}
          onClose={() => setReport(null)}
          onDone={() => {
            setReport(null);
            setNotice("Reported. The batch0 team will look at it. Nobody else is told who reported.");
          }}
        />
      ) : null}
      {reportDeleted ? (
        <ReportDeletedDialog
          channel={channel}
          people={people}
          preselect={reportDeleted}
          moderator={viewer.staff}
          onClose={() => setReportDeleted(null)}
          onDone={() => {
            setReportDeleted(null);
            setNotice("Reported. The batch0 team will look at it. Nobody else is told who reported.");
          }}
        />
      ) : null}
      {flagging ? (
        <FlagDialog
          message={flagging}
          people={people}
          threads
          onClose={() => setFlagging(null)}
          onDone={(result: FlagResult | null) => {
            setFlagging(null);
            setNotice(helpNotice(result));
            void refresh();
          }}
        />
      ) : null}
      {muting ? (
        <MuteDialog
          userId={muting.userId}
          name={muting.name}
          onClose={() => setMuting(null)}
          onDone={(text) => {
            setMuting(null);
            setNotice(text);
          }}
        />
      ) : null}
    </div>
  );
}

/** What "Ask the team" says once it went through. */
export function helpNotice(result: FlagResult | null): string {
  if (!result?.outcome) return "Sent to the batch0 team. Someone will take a look.";
  const ref = result.reference ? ` (${result.reference})` : "";
  if (result.outcome === "created") return `Sent to the batch0 team as a help request${ref}. The thread shows when it's handled.`;
  if (result.outcome === "reopened") return `This thread's help request${ref} is open again. The team will pick it back up.`;
  return `This thread already has a help request${ref}. You've been added to it.`;
}

/** The question's state and what the asker or the team can do with it (#help, 0110). */
function QuestionControls({
  info,
  hasRoot,
  busy,
  answer,
  people,
  onDecide,
  onJump,
}: {
  info: ThreadInfo;
  hasRoot: boolean;
  busy: boolean;
  answer: UiMessage | null;
  people: Record<string, ChatPerson>;
  onDecide: (action: QuestionAction) => void;
  onJump: (id: string) => void;
}) {
  if (!info.questionChannel || !hasRoot) return null;
  const btn = "inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:border-ink/30 hover:text-ink disabled:opacity-50";
  if (info.question === null) {
    return info.canDecide ? (
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button type="button" className={btn} disabled={busy} onClick={() => onDecide("ask")}>
          <CircleHelp className="h-3.5 w-3.5" aria-hidden />
          Make it a question
        </button>
      </div>
    ) : null;
  }
  return (
    <div className="mt-2.5 space-y-2" role="group" aria-label="Question">
      <div className="flex flex-wrap items-center gap-2">
        <QuestionBadge state={info.question} />
        {info.question === "open" && info.canDecide ? (
          <>
            <button type="button" className={btn} disabled={busy} onClick={() => onDecide("mark_answered")}>
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              Mark answered
            </button>
            <button type="button" className={btn} disabled={busy} onClick={() => onDecide("unmark")}>
              Not a question
            </button>
          </>
        ) : null}
        {info.question === "answered" && info.canDecide ? (
          <button type="button" className={btn} disabled={busy} onClick={() => onDecide("reopen")}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Reopen
          </button>
        ) : null}
      </div>
      {info.question === "answered" && info.answerId ? (
        <button
          type="button"
          onClick={() => onJump(info.answerId!)}
          className="block w-full rounded-md border border-phosphor/40 bg-phosphor/5 px-2.5 py-1.5 text-left text-xs text-ink-soft hover:bg-phosphor/10"
        >
          <span className="font-semibold text-ink">Accepted answer{answer ? ` from ${senderName(answer, people)}` : ""}:</span>{" "}
          {answer ? plainText(answer.body || "[attachment]", (id) => people[id]?.name, () => null, 140) : "Show it"}
        </button>
      ) : null}
      {info.question === "open" ? (
        <p className="text-[11px] text-ink-faint">
          {info.canDecide
            ? "When a reply answers it, accept it from the reply's ••• menu."
            : "The person who asked, or the batch0 team, marks it answered."}
        </p>
      ) : null}
    </div>
  );
}

/** The thread's help request: its state and owner, from its Support ticket (the one record). */
function HelpLine({ help }: { help: NonNullable<ThreadInfo["help"]> }) {
  const state = help.status === "handled" ? "Handled" : help.owner ? `${help.owner} has it` : "Waiting for someone on the team";
  return (
    <p className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
      <LifeBuoy className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Asked the team · <span className="font-medium text-ink">{state}</span>
      </span>
      {help.href ? (
        <a href={help.href} className="link-ink">
          {help.reference ? `Open ${help.reference}` : "Open the request"}
        </a>
      ) : null}
    </p>
  );
}
