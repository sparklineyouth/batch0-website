"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Ban,
  CornerDownLeft,
  Flag,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { getActionError } from "@/lib/action-error";
import { MESSAGE_MAX } from "@/lib/dm-access";
import type { DmMessage } from "@/lib/dm";
import {
  blockPerson,
  markRead,
  reportDm,
  sendDm,
  unblockPerson,
  unsendDm,
  type ThreadPayload,
} from "@/app/messages/actions";
import { Avatar, PersonLabel } from "@/components/messages/person";
import { useThreadLive, type LiveMessage } from "@/components/messages/use-dm-live";

/**
 * One conversation, rendered the same whether it's in the popup or on the full
 * page. `compact` only changes spacing and which chrome shows — the behaviour,
 * the rules it enforces, and the actions it calls are identical, so the popup
 * can never quietly be the weaker surface.
 */

type Pending = DmMessage & { pending?: true };

export function MessageThread({
  viewerId,
  initial,
  compact = false,
  onChanged,
  onBack,
  backMobileOnly = false,
}: {
  viewerId: string;
  initial: ThreadPayload;
  compact?: boolean;
  /** Called after anything that changes the inbox, so the list can refresh. */
  onChanged?: () => void;
  /** Go back to the conversation list. */
  onBack?: () => void;
  /**
   * Hide the back arrow on desktop. The full page keeps the list visible
   * beside the thread there, so "back" would only blank the right pane.
   */
  backMobileOnly?: boolean;
}) {
  const [thread, setThread] = useState(initial);
  const [messages, setMessages] = useState<Pending[]>(initial.messages);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<"block" | "report" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // Where the viewer had read up to when this thread loaded. Frozen for the
  // life of the mount on purpose: marking read immediately would otherwise
  // erase the "new" divider before they've looked at it.
  const cursorRef = useRef(initial.cursor);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Switching conversation reuses this component; reset everything that
  // belongs to the old one. Keyed on WHICH conversation, not on the identity
  // of the prop object — a parent re-render that rebuilds the object literal
  // must not wipe a half-typed message.
  const identity = initial.conversationId ?? `draft:${initial.other.id}`;
  const loadedRef = useRef(identity);
  useEffect(() => {
    if (loadedRef.current === identity) return;
    loadedRef.current = identity;
    setThread(initial);
    setMessages(initial.messages);
    setDraft("");
    setError(null);
    cursorRef.current = initial.cursor;
  }, [identity, initial]);

  const conversationId = thread.conversationId;

  const scrollToEnd = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  useEffect(() => {
    scrollToEnd();
  }, [conversationId, scrollToEnd]);

  // Clear the unread flag for this conversation. Called on open and whenever a
  // message arrives while it's on screen — if you're looking at it, you've
  // read it.
  const clearUnread = useCallback(() => {
    if (!conversationId || thread.moderatorView) return;
    markRead(conversationId)
      .then(() => onChanged?.())
      .catch(() => {
        /* best-effort: the badge self-corrects on the next poll */
      });
  }, [conversationId, thread.moderatorView, onChanged]);

  useEffect(() => {
    clearUnread();
  }, [clearUnread]);

  // Live: a DELETE payload carries only the id (that's an unsend), an INSERT
  // carries the row.
  const onLive = useCallback(
    (m: LiveMessage) => {
      if (!m.created_at) {
        setMessages((prev) => prev.filter((x) => x.id !== m.id));
        return;
      }
      setMessages((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev;
        const row: Pending = {
          id: m.id,
          conversationId: m.conversation_id,
          senderId: m.sender_id,
          senderName: m.sender_id === viewerId ? "You" : thread.other.name,
          body: m.body,
          createdAt: m.created_at,
        };
        // Our own echo can beat the action's reply back to us, and then the
        // reply renames the optimistic bubble to the same id — two rows, one
        // id, one duplicated message on screen. Whichever arrives first
        // adopts the pending bubble; the other one sees it already has the id
        // and bails out above.
        if (m.sender_id === viewerId) {
          const pendingIdx = prev.findIndex((x) => x.pending && x.body === m.body);
          if (pendingIdx !== -1) {
            const next = [...prev];
            next[pendingIdx] = row;
            return next;
          }
        }
        return [...prev, row].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });
      if (m.sender_id !== viewerId) clearUnread();
      requestAnimationFrame(() => scrollToEnd(true));
    },
    [viewerId, thread.other.name, clearUnread, scrollToEnd],
  );

  useThreadLive(conversationId, onLive);

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setError(null);
    setSending(true);
    // Optimistic: the message shows the instant you hit Enter, dimmed until
    // the server confirms. A chat that waits a round trip to echo your own
    // words feels broken even when it isn't.
    const tempId = `pending-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        conversationId: conversationId ?? "",
        senderId: viewerId,
        senderName: "You",
        body,
        createdAt: new Date().toISOString(),
        pending: true,
      },
    ]);
    setDraft("");
    requestAnimationFrame(() => scrollToEnd(true));

    try {
      const res = await sendDm(
        conversationId
          ? { conversationId, body }
          : { toUserId: thread.other.id, body },
      );
      if (!res.ok) {
        // Drop the optimistic bubble and hand the words back, so a rate limit
        // or a block never costs someone what they typed.
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        setDraft(body);
        setError(res.error);
        return;
      }
      const data = res.data!;
      setMessages((prev) => {
        // The realtime echo may already have replaced the pending bubble with
        // the real row (see onLive). Then there is nothing to reconcile, and
        // renaming would duplicate the id.
        if (prev.some((m) => m.id === data.messageId)) {
          return prev.filter((m) => m.id !== tempId);
        }
        return prev.map((m) =>
          m.id === tempId
            ? {
                ...m,
                id: data.messageId,
                createdAt: data.createdAt,
                conversationId: data.conversationId,
                pending: undefined,
              }
            : m,
        );
      });
      // First message in a draft thread: the conversation now exists, so
      // adopt its id and the live subscription starts.
      if (!conversationId) {
        setThread((t) => ({ ...t, conversationId: data.conversationId }));
      }
      onChanged?.();
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setDraft(body);
      setError(getActionError(err));
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }

  async function doUnsend(id: string) {
    const snapshot = messages;
    setMessages((prev) => prev.filter((m) => m.id !== id));
    const res = await unsendDm(id);
    if (!res.ok) {
      setMessages(snapshot);
      setError(res.error);
    } else {
      onChanged?.();
    }
  }

  async function doBlock() {
    setBusy(true);
    const res = await blockPerson(thread.other.id);
    setBusy(false);
    setConfirm(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setThread((t) => ({ ...t, blockedByYou: true, frozen: true, canSend: false }));
    onChanged?.();
  }

  async function doUnblock() {
    setBusy(true);
    const res = await unblockPerson(thread.other.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setThread((t) => ({ ...t, blockedByYou: false, frozen: false, canSend: true }));
    onChanged?.();
  }

  async function doReport() {
    if (!conversationId) return;
    setBusy(true);
    const res = await reportDm({ conversationId, reason });
    setBusy(false);
    setConfirm(null);
    setReason("");
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
  }

  const rows = useMemo(() => groupRows(messages, cursorRef.current, viewerId), [messages, viewerId]);
  const nearLimit = draft.length > MESSAGE_MAX - 300;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            className={`press -ml-1 h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-wash hover:text-ink ${
              backMobileOnly ? "flex md:hidden" : "flex"
            }`}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <Avatar person={thread.other} size="sm" />
        <div className="min-w-0 flex-1">
          <PersonLabel person={thread.other} className="text-sm" />
        </div>
        {compact && conversationId && (
          <Link
            href={`/messages?c=${conversationId}`}
            prefetch={false}
            aria-label="Open in full view"
            className="press flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-wash hover:text-ink"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Link>
        )}
        {!thread.moderatorView && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Conversation options"
              aria-expanded={menuOpen}
              className="press flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-wash hover:text-ink"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menuOpen && (
              <>
                {/* Click-away. Sits under the menu, over everything else. */}
                <button
                  type="button"
                  aria-hidden
                  tabIndex={-1}
                  onClick={() => setMenuOpen(false)}
                  className="fixed inset-0 z-10 cursor-default"
                />
                <div className="absolute right-0 top-8 z-20 w-52 overflow-hidden rounded-lg border border-line bg-paper py-1 shadow-lg">
                  {thread.blockedByYou ? (
                    <MenuItem
                      onClick={() => {
                        setMenuOpen(false);
                        doUnblock();
                      }}
                    >
                      <Ban className="h-3.5 w-3.5" />
                      Unblock {firstName(thread.other.name)}
                    </MenuItem>
                  ) : (
                    <MenuItem
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirm("block");
                      }}
                    >
                      <Ban className="h-3.5 w-3.5" />
                      Block {firstName(thread.other.name)}
                    </MenuItem>
                  )}
                  {conversationId && (
                    <MenuItem
                      destructive
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirm("report");
                      }}
                    >
                      <Flag className="h-3.5 w-3.5" />
                      Report conversation
                    </MenuItem>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {thread.moderatorView && (
        <p className="border-b border-line bg-wash px-3 py-2 text-[11px] text-ink-soft">
          You&apos;re reading this because it was reported. Read-only — you
          can&apos;t post here.
        </p>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className={`min-h-0 flex-1 overflow-y-auto ${compact ? "px-3 py-3" : "px-4 py-5"}`}
      >
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <Avatar person={thread.other} size="lg" />
            <p className="mt-3 text-sm font-medium text-ink">{thread.other.name}</p>
            <p className="mt-1 text-xs text-ink-faint">
              No messages yet. Say hello — they&apos;ll get a notification.
            </p>
          </div>
        ) : (
          <ul className="space-y-1">
            {rows.map((row) =>
              row.kind === "day" ? (
                <li key={row.key} className="flex items-center gap-3 py-3">
                  <span className="h-px flex-1 bg-line" />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                    {row.label}
                  </span>
                  <span className="h-px flex-1 bg-line" />
                </li>
              ) : row.kind === "unread" ? (
                <li key={row.key} className="flex items-center gap-3 py-2">
                  <span className="h-px flex-1 bg-phosphor/50" />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-phosphor-ink">
                    New
                  </span>
                  <span className="h-px flex-1 bg-phosphor/50" />
                </li>
              ) : (
                <MessageBubble
                  key={row.message.id}
                  message={row.message}
                  mine={row.message.senderId === viewerId}
                  showTail={row.showTail}
                  onUnsend={
                    row.message.senderId === viewerId && !row.message.pending
                      ? () => doUnsend(row.message.id)
                      : undefined
                  }
                />
              ),
            )}
          </ul>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-line px-3 py-2.5">
        {error && (
          <p role="alert" className="mb-2 text-xs text-red-400">
            {error}
          </p>
        )}
        {thread.moderatorView ? null : thread.blockedByYou ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-wash px-3 py-2">
            <p className="text-xs text-ink-soft">
              You blocked {thread.other.name}. Neither of you can send.
            </p>
            <Button size="sm" variant="secondary" onClick={doUnblock} disabled={busy}>
              Unblock
            </Button>
          </div>
        ) : thread.frozen ? (
          // Deliberately does not say the other person blocked you.
          <p className="rounded-md bg-wash px-3 py-2 text-xs text-ink-soft">
            You can&apos;t send messages in this conversation.
          </p>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, MESSAGE_MAX))}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter is a newline — what every chat does.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder={`Message ${firstName(thread.other.name)}…`}
              aria-label={`Message ${thread.other.name}`}
              className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-md border border-line bg-paper px-3 py-2 text-base text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-2 focus:ring-phosphor/30 md:text-sm"
            />
            <Button size="sm" onClick={send} disabled={sending || !draft.trim()} className="h-10">
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CornerDownLeft className="h-3.5 w-3.5" />
              )}
              <span className="sr-only">Send</span>
            </Button>
          </div>
        )}
        {nearLimit && (
          <p className="mt-1 text-right text-[10px] font-mono tabular-nums text-ink-faint">
            {draft.length}/{MESSAGE_MAX}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirm === "block"}
        title={`Block ${thread.other.name}?`}
        description="Neither of you will be able to send messages. Your conversation stays where it is, and they aren't told."
        confirmLabel="Block"
        destructive
        pending={busy}
        onConfirm={doBlock}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "report"}
        title="Report this conversation?"
        description={
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">
              This is the only thing that lets the batch0 team read this
              conversation. Reporting it hands them the whole thread, including
              your own messages.
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="What's wrong?"
              aria-label="Why you're reporting this"
              className="w-full resize-none rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-2 focus:ring-phosphor/30"
            />
          </div>
        }
        confirmLabel="Report"
        destructive
        pending={busy}
        onConfirm={doReport}
        onCancel={() => {
          setConfirm(null);
          setReason("");
        }}
      />
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  destructive = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-wash ${
        destructive ? "text-red-400" : "text-ink-soft hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function MessageBubble({
  message,
  mine,
  showTail,
  onUnsend,
}: {
  message: Pending;
  mine: boolean;
  /** Last of a run from the same sender: gets the timestamp and the corner. */
  showTail: boolean;
  onUnsend?: () => void;
}) {
  return (
    <li className={`group flex items-end gap-1.5 ${mine ? "justify-end" : "justify-start"}`}>
      {mine && onUnsend && (
        <button
          type="button"
          onClick={onUnsend}
          aria-label="Unsend message"
          // Hover-only on pointer devices; always reachable by keyboard.
          className="press mb-1 flex h-6 w-6 items-center justify-center rounded-md text-ink-faint opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-400"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
      <div className={`flex max-w-[78%] flex-col ${mine ? "items-end" : "items-start"}`}>
        <div
          className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-sm leading-snug ${
            mine
              ? `bg-phosphor text-on-phosphor ${showTail ? "rounded-br-md" : ""}`
              : `border border-line bg-wash text-ink ${showTail ? "rounded-bl-md" : ""}`
          } ${message.pending ? "opacity-60" : ""}`}
        >
          {message.body}
        </div>
        {showTail && (
          <span className="mt-0.5 px-1 text-[10px] font-mono tabular-nums text-ink-faint">
            {message.pending ? "Sending…" : timeOf(message.createdAt)}
          </span>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "unread"; key: string }
  | { kind: "message"; message: Pending; showTail: boolean };

/**
 * Turn a flat message list into what gets rendered: a day divider when the
 * date changes, a "New" divider at the viewer's read cursor, and a tail flag
 * on the last message of each run by one sender so only that one carries a
 * timestamp.
 */
function groupRows(messages: Pending[], cursor: string, viewerId: string): Row[] {
  const rows: Row[] = [];
  let lastDay = "";
  let unreadMarked = false;
  messages.forEach((m, i) => {
    const day = dayKey(m.createdAt);
    if (day !== lastDay) {
      rows.push({ kind: "day", key: `day-${day}`, label: dayLabel(m.createdAt) });
      lastDay = day;
    }
    // The first message from the other person that landed after the viewer
    // last looked. Their own messages never qualify — you've read what you sent.
    if (!unreadMarked && m.senderId !== viewerId && m.createdAt > cursor) {
      rows.push({ kind: "unread", key: `unread-${m.id}` });
      unreadMarked = true;
    }
    const next = messages[i + 1];
    const showTail =
      !next || next.senderId !== m.senderId || dayKey(next.createdAt) !== day;
    rows.push({ kind: "message", message: m, showTail });
  });
  return rows;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return "Today";
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function timeOf(iso: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
