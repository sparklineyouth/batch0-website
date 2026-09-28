"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  fetchMessages,
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

/**
 * How often an open, visible thread reconciles with the server. Realtime
 * carries new messages the instant they land; this catches what it can't —
 * anything sent while the socket was down, and every unsend.
 */
const RESYNC_MS = 20_000;

/** Within this many pixels of the bottom counts as "reading the latest". */
const NEAR_BOTTOM_PX = 120;

/**
 * An open, visible thread tells the server "still here" at least this often,
 * even with nothing new to mark read — that presence is what keeps a
 * conversation someone is sitting in from ringing their bell.
 */
const PRESENCE_MS = 60_000;

export function MessageThread({
  viewerId,
  initial,
  compact = false,
  onChanged,
  onBack,
  backMobileOnly = false,
  onConversationCreated,
  onNavigateAway,
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
  /** A draft's first message created the conversation; here is its id. */
  onConversationCreated?: (conversationId: string) => void;
  /** A link out of the thread was followed (the dock closes itself). */
  onNavigateAway?: () => void;
}) {
  const [thread, setThread] = useState(initial);
  const [messages, setMessages] = useState<Pending[]>(initial.messages);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<
    { kind: "block" } | { kind: "report" } | { kind: "unsend"; id: string } | null
  >(null);
  const [reason, setReason] = useState("");
  const [reportError, setReportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Times and day dividers are in the viewer's own timezone, which the server
  // render can't know — so they appear once the page is in the browser rather
  // than hydrating a UTC guess into a mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Where the viewer had read up to when this thread loaded. Frozen for the
  // life of the mount on purpose: marking read immediately would otherwise
  // erase the "new" divider before they've looked at it.
  const cursorRef = useRef(initial.cursor);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // Scroll to the newest message once the rows for a (newly) loaded
  // conversation have rendered.
  const scrollPendingRef = useRef(true);
  // Messages being unsent: kept out of any resync that could still carry
  // them, so an unsent message can't flicker back.
  const unsendingRef = useRef(new Map<string, number | null>());

  // Switching conversation reuses this component; reset everything that
  // belongs to the old one. Keyed on WHO the conversation is with, not on its
  // id: a draft's first send gives it an id, and the parent adopting that id
  // must not wipe the thread it belongs to. (A moderator's view has no "other
  // person" of their own, so it keys on the id.)
  const identity = initial.moderatorView
    ? `mod:${initial.conversationId}`
    : `with:${initial.other.id}`;
  const loadedRef = useRef(identity);
  const lastInitialRef = useRef(initial);
  useEffect(() => {
    const previous = lastInitialRef.current;
    lastInitialRef.current = initial;
    if (loadedRef.current === identity) {
      // Same conversation, fresh copy from the server — the dock refetches it
      // on reopen. Adopt it, keeping the half-typed draft and anything still
      // sending. (A parent that only adopts a new conversation id reuses the
      // same messages array, and changes nothing here.)
      if (initial !== previous && initial.messages !== previous.messages) {
        setThread(initial);
        setMessages((prev) => [...initial.messages, ...prev.filter((m) => m.pending)].sort(byTime));
        cursorRef.current = initial.cursor;
        scrollPendingRef.current = true;
      }
      return;
    }
    loadedRef.current = identity;
    setThread(initial);
    setMessages(initial.messages);
    setDraft("");
    setError(null);
    setNotice(null);
    setConfirm(null);
    setMenuOpen(false);
    cursorRef.current = initial.cursor;
    unsendingRef.current.clear();
    scrollPendingRef.current = true;
  }, [identity, initial]);

  const conversationId = thread.conversationId;
  // For async work to check it's still looking at the conversation it
  // started for: a late answer must not land in the next one.
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);

  const scrollToEnd = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Open on the latest message — once the rows for the loaded conversation
  // exist (they render after mount, and after a switch's state reset).
  useLayoutEffect(() => {
    if (!mounted || !scrollPendingRef.current) return;
    scrollPendingRef.current = false;
    scrollToEnd();
  }, [messages, mounted, scrollToEnd]);

  /** The newest confirmed message on screen: how far "read" may go. */
  const newestShown = useCallback((): string | undefined => {
    let newest: string | undefined;
    for (const m of messagesRef.current) {
      if (m.pending) continue;
      if (!newest || isAfter(m.createdAt, newest)) newest = m.createdAt;
    }
    return newest;
  }, []);

  // Mark read up to what the viewer can actually see — and only while they
  // can see it. A thread open in a background tab reads nothing; the tab
  // coming back does. Skipped when nothing new is on screen, except to
  // refresh presence every PRESENCE_MS; the inbox refetches only when the
  // server says something it shows actually changed.
  const lastMarkRef = useRef<{ upTo: string | undefined; at: number }>({ upTo: undefined, at: 0 });
  const markSeen = useCallback(
    (upTo?: string) => {
      const id = conversationId;
      if (!id || thread.moderatorView) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const target = upTo ?? newestShown();
      const last = lastMarkRef.current;
      const newer = !!target && (!last.upTo || isAfter(target, last.upTo));
      if (!newer && Date.now() - last.at < PRESENCE_MS) return;
      lastMarkRef.current = { upTo: newer ? target : last.upTo, at: Date.now() };
      markRead(id, target)
        .then((res) => {
          if (res.ok && res.data?.changed) onChanged?.();
        })
        .catch(() => {
          /* best-effort: the badge self-corrects on the next poll */
        });
    },
    [conversationId, thread.moderatorView, newestShown, onChanged],
  );

  useEffect(() => {
    markSeen();
  }, [markSeen]);

  /**
   * Reconcile with the server's newest messages. New ones are added, and
   * messages that are gone from inside the window the server returned (an
   * unsend, a moderator removal) are dropped. Anything newer than that window
   * — a live message that landed while this request was in flight — and
   * anything still sending are kept.
   */
  const resync = useCallback(async () => {
    const id = conversationId;
    if (!id) return;
    const startedAt = Date.now();
    let server: DmMessage[];
    let asOf: string;
    let complete: boolean;
    try {
      ({ messages: server, asOf, complete } = await fetchMessages(id));
    } catch {
      return;
    }
    // Switched away while it was in flight: this answer is for another thread.
    if (conversationIdRef.current !== id) return;
    // An unsend this request may have raced: keep it out, and forget it once
    // a request that began after the unsend succeeded has come back.
    for (const [mid, doneAt] of unsendingRef.current) {
      if (doneAt !== null && startedAt > doneAt) unsendingRef.current.delete(mid);
    }
    server = server.filter((m) => !unsendingRef.current.has(m.id));
    const wasNearBottom = isNearBottom();
    // Decided here, from what is on screen now — a state updater runs later,
    // so a flag set inside one would still be false on the next line.
    const onScreen = new Set(messagesRef.current.map((m) => m.id));
    const arrived = server.some((m) => !onScreen.has(m.id) && m.senderId !== viewerId);
    setMessages((prev) => {
      const ids = new Set(server.map((m) => m.id));
      const known = new Set(prev.map((m) => m.id));
      const oldest = server[0]?.createdAt ?? null;
      // A confirmed message the server didn't return is kept only when the
      // server couldn't have known about it: created after its snapshot (it
      // arrived live mid-request), or older than a list that was cut at the
      // limit. Everything else it didn't return is gone — unsent or removed.
      const outside = prev.filter(
        (m) =>
          !m.pending &&
          !ids.has(m.id) &&
          (isAfter(m.createdAt, asOf) || (!complete && oldest !== null && isAfter(oldest, m.createdAt))),
      );
      const pending = prev.filter(
        (m) => m.pending && !server.some((s) => s.senderId === viewerId && s.body === m.body && !known.has(s.id)),
      );
      const next: Pending[] = [...outside, ...server, ...pending].sort(byTime);
      const same =
        next.length === prev.length && next.every((m, i) => m.id === prev[i].id && !!m.pending === !!prev[i].pending);
      return same ? prev : next;
    });
    if (arrived) {
      // Read up to the newest thing now on screen — worked out from the
      // server's rows, because messagesRef won't reflect this update yet.
      const newestServer = server.reduce<string | undefined>(
        (a, m) => (!a || isAfter(m.createdAt, a) ? m.createdAt : a),
        undefined,
      );
      const current = newestShown();
      markSeen(newestServer && (!current || isAfter(newestServer, current)) ? newestServer : current);
      if (wasNearBottom) requestAnimationFrame(() => scrollToEnd(true));
    }
  }, [conversationId, viewerId, isNearBottom, markSeen, newestShown, scrollToEnd]);

  // Resync when the tab comes back or the window regains focus, and on a
  // slow timer while the thread is visible.
  useEffect(() => {
    if (!conversationId) return;
    // visibilitychange and focus usually fire together on a tab switch; one
    // round trip covers both.
    let lastVisible = 0;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastVisible < 2_000) return;
      lastVisible = Date.now();
      markSeen();
      void resync();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void resync();
      markSeen(); // presence refresh; a no-op until PRESENCE_MS has passed
    }, RESYNC_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      clearInterval(t);
    };
  }, [conversationId, markSeen, resync]);

  // Live: an INSERT carries the row.
  const onLive = useCallback(
    (m: LiveMessage) => {
      if (!m?.id || !m.created_at) return;
      if (m.conversation_id !== conversationIdRef.current) return;
      if (unsendingRef.current.has(m.id)) return;
      const wasNearBottom = isNearBottom();
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
            return next.sort(byTime);
          }
        }
        return [...prev, row].sort(byTime);
      });
      if (m.sender_id !== viewerId) markSeen(m.created_at);
      // Follow the conversation only if the viewer was already at the bottom
      // (or wrote it): someone scrolled up to reread something shouldn't be
      // yanked away by every new line.
      if (wasNearBottom || m.sender_id === viewerId) {
        requestAnimationFrame(() => scrollToEnd(true));
      }
    },
    [viewerId, thread.other.name, markSeen, isNearBottom, scrollToEnd],
  );

  useThreadLive(conversationId, onLive, resync);

  // Escape closes the options menu — and only the menu. Captured, and marked
  // handled, so the dock's own Escape (back to the list) leaves it alone.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuOpen]);

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setError(null);
    setNotice(null);
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

    // Hand the words back on failure — unless the person has already started
    // typing something else, which must not be overwritten.
    const restore = () => setDraft((current) => (current.trim() ? current : body));

    try {
      const res = await sendDm(
        conversationId
          ? { conversationId, body }
          : { toUserId: thread.other.id, body },
      );
      if (!res.ok) {
        // Drop the optimistic bubble, so a rate limit or a block never costs
        // someone what they typed.
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        restore();
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
        return prev
          .map((m) =>
            m.id === tempId
              ? {
                  ...m,
                  id: data.messageId,
                  createdAt: data.createdAt,
                  conversationId: data.conversationId,
                  pending: undefined,
                }
              : m,
          )
          .sort(byTime);
      });
      // First message in a draft thread: the conversation now exists, so
      // adopt its id (the live subscription starts) and tell the page.
      if (!conversationId) {
        setThread((t) => ({ ...t, conversationId: data.conversationId }));
        onConversationCreated?.(data.conversationId);
      }
      onChanged?.();
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      restore();
      setError(getActionError(err));
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }

  async function doUnsend(id: string) {
    const removed = messagesRef.current.find((m) => m.id === id);
    if (!removed) return;
    setBusy(true);
    unsendingRef.current.set(id, null);
    setMessages((prev) => prev.filter((m) => m.id !== id));
    // Put back only this one message on failure — never a stale copy of the
    // whole list, which would erase anything that arrived meanwhile.
    const putBack = () => {
      unsendingRef.current.delete(id);
      setMessages((prev) => (prev.some((m) => m.id === id) ? prev : [...prev, removed].sort(byTime)));
    };
    try {
      const res = await unsendDm(id);
      if (!res.ok) {
        putBack();
        setError(res.error);
      } else {
        unsendingRef.current.set(id, Date.now());
        onChanged?.();
      }
    } catch (err) {
      putBack();
      setError(getActionError(err));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function doBlock() {
    setBusy(true);
    try {
      const res = await blockPerson(thread.other.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setThread((t) => ({ ...t, blockedByYou: true, frozen: true, canSend: false }));
      onChanged?.();
    } catch (err) {
      setError(getActionError(err));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function doUnblock() {
    setBusy(true);
    try {
      const res = await unblockPerson(thread.other.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setThread((t) => ({ ...t, blockedByYou: false, frozen: false, canSend: true }));
      onChanged?.();
    } catch (err) {
      setError(getActionError(err));
    } finally {
      setBusy(false);
    }
  }

  async function doReport() {
    if (!conversationId) return;
    setBusy(true);
    setReportError(null);
    try {
      const res = await reportDm({ conversationId, reason });
      if (!res.ok) {
        // Keep the dialog and what they wrote; say why it didn't go.
        setReportError(res.error);
        return;
      }
      setConfirm(null);
      setReason("");
      setError(null);
      setNotice("Reported. The batch0 team will review this conversation.");
    } catch (err) {
      setReportError(getActionError(err));
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(
    () => (mounted ? groupRows(messages, cursorRef.current, viewerId) : []),
    [messages, viewerId, mounted],
  );
  const nearLimit = draft.length > MESSAGE_MAX - 300;
  const unsendTarget =
    confirm?.kind === "unsend" ? messages.find((m) => m.id === confirm.id) ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            className={`press -ml-1 h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-wash hover:text-ink ${
              backMobileOnly ? "flex md:hidden" : "flex"
            }`}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <Avatar person={thread.other} size="sm" />
        <div className="flex min-w-0 flex-1">
          <PersonLabel person={thread.other} className="text-sm" />
        </div>
        {compact && conversationId && (
          <Link
            href={`/messages?c=${conversationId}`}
            prefetch={false}
            onClick={() => onNavigateAway?.()}
            aria-label="Open in full view"
            className="press flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-wash hover:text-ink"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Link>
        )}
        {!thread.moderatorView && (
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Conversation options"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
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
                <div
                  role="menu"
                  className="absolute right-0 top-8 z-20 w-52 overflow-hidden rounded-lg border border-line bg-paper py-1 shadow-lg"
                >
                  {thread.otherDeleted ? null : thread.blockedByYou ? (
                    <MenuItem
                      onClick={() => {
                        setMenuOpen(false);
                        doUnblock();
                      }}
                    >
                      <Ban className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">Unblock {firstName(thread.other.name)}</span>
                    </MenuItem>
                  ) : (
                    <MenuItem
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirm({ kind: "block" });
                      }}
                    >
                      <Ban className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">Block {firstName(thread.other.name)}</span>
                    </MenuItem>
                  )}
                  {conversationId && (
                    <MenuItem
                      destructive
                      onClick={() => {
                        setMenuOpen(false);
                        setReportError(null);
                        setConfirm({ kind: "report" });
                      }}
                    >
                      <Flag className="h-3.5 w-3.5 shrink-0" />
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
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${compact ? "px-3 py-3" : "px-4 py-5"}`}
      >
        {!mounted ? null : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <Avatar person={thread.other} size="lg" />
            <p className="mt-3 max-w-full break-words text-sm font-medium text-ink">{thread.other.name}</p>
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
                    row.message.senderId === viewerId &&
                    !row.message.pending &&
                    !thread.moderatorView
                      ? () => setConfirm({ kind: "unsend", id: row.message.id })
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
        {notice && !error && (
          <p role="status" className="mb-2 text-xs text-ink-soft">
            {notice}
          </p>
        )}
        {thread.moderatorView ? null : thread.otherDeleted ? (
          <p className="rounded-md bg-wash px-3 py-2 text-xs text-ink-soft">
            This account was deleted. The conversation stays here, read-only.
          </p>
        ) : thread.blockedByYou ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-wash px-3 py-2">
            <p className="min-w-0 break-words text-xs text-ink-soft">
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
                // Never while an IME is composing: isComposing covers most
                // browsers, and keyCode 229 covers Safari, which fires the
                // committing Enter after compositionend.
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder={`Message ${firstName(thread.other.name)}…`}
              aria-label={`Message ${thread.other.name}`}
              className="max-h-32 min-h-[2.5rem] min-w-0 flex-1 resize-none rounded-md border border-line bg-paper px-3 py-2 text-base text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-2 focus:ring-phosphor/30 md:text-sm"
            />
            <Button size="sm" onClick={send} disabled={sending || !draft.trim()} className="h-10 shrink-0">
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
        open={confirm?.kind === "block"}
        title={`Block ${thread.other.name}?`}
        description="Neither of you will be able to send messages. Your conversation stays where it is, and they aren't told."
        confirmLabel="Block"
        destructive
        pending={busy}
        onConfirm={doBlock}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === "unsend"}
        title="Unsend this message?"
        description={
          <div className="space-y-2">
            <p className="text-sm text-ink-soft">
              It disappears for both of you. This can&apos;t be undone.
            </p>
            {unsendTarget && (
              <p className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-wash px-3 py-2 text-xs text-ink-soft [overflow-wrap:anywhere]">
                {unsendTarget.body}
              </p>
            )}
          </div>
        }
        confirmLabel="Unsend"
        destructive
        pending={busy}
        onConfirm={() => confirm?.kind === "unsend" && doUnsend(confirm.id)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === "report"}
        title="Report this conversation?"
        description={
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">
              This is the only thing that lets the batch0 team read this
              conversation. Reporting it hands them the whole thread, including
              your own messages, and nothing in it can be unsent afterwards.
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="What's wrong?"
              aria-label="Why you're reporting this"
              className="w-full resize-none rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-2 focus:ring-phosphor/30"
            />
            {reportError && (
              <p role="alert" className="text-xs text-red-400">
                {reportError}
              </p>
            )}
          </div>
        }
        confirmLabel="Report"
        destructive
        pending={busy}
        onConfirm={doReport}
        onCancel={() => {
          setConfirm(null);
          setReportError(null);
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
      role="menuitem"
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
          // Hover-only with a pointer; always reachable by keyboard, and
          // always shown on touch screens, where there is no hover.
          className="press mb-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-400 [@media(hover:none)]:opacity-60"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
      <div className={`flex min-w-0 max-w-[78%] flex-col ${mine ? "items-end" : "items-start"}`}>
        <div
          className={`max-w-full whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-sm leading-snug [overflow-wrap:anywhere] ${
            mine
              ? `bg-phosphor text-on-phosphor ${showTail ? "rounded-br-md" : ""}`
              : `border border-line bg-wash text-ink ${showTail ? "rounded-bl-md" : ""}`
          } ${message.pending || message.unsentAt ? "opacity-60" : ""}`}
        >
          {message.body}
        </div>
        {(showTail || message.unsentAt) && (
          <span className="mt-0.5 px-1 text-[10px] font-mono tabular-nums text-ink-faint">
            {message.pending ? "Sending…" : timeOf(message.createdAt)}
            {message.unsentAt ? " · unsent by sender" : ""}
          </span>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Is timestamp `a` later than `b`? As instants first; a millisecond tie falls
 * back to the string, because Postgres keeps microseconds that Date drops.
 */
function isAfter(a: string, b: string): boolean {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isFinite(da) && Number.isFinite(db) && da !== db) return da > db;
  return a > b;
}

/**
 * Posting order. By instant rather than by string: an optimistic bubble
 * carries the browser's ISO time ("…Z") while confirmed rows carry Postgres's
 * ("…+00:00"), and those don't sort against each other as text.
 */
function byTime(a: Pending, b: Pending): number {
  if (a.createdAt === b.createdAt) return 0;
  return isAfter(a.createdAt, b.createdAt) ? 1 : -1;
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
    if (!unreadMarked && m.senderId !== viewerId && !m.pending && isAfter(m.createdAt, cursor)) {
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
