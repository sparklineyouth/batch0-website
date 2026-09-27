"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, MessageCircle, MessageSquarePlus, X } from "lucide-react";
import type { DmInboxRow, DmPerson } from "@/lib/dm";
import {
  fetchInbox,
  fetchThread,
  fetchUnreadCount,
  type ThreadPayload,
} from "@/app/messages/actions";
import { ConversationList } from "@/components/messages/conversation-list";
import { MessageThread } from "@/components/messages/message-thread";
import { PeopleSearch } from "@/components/messages/people-search";
import { useInboxLive } from "@/components/messages/use-dm-live";

/**
 * The chat dock: a launcher pinned bottom-right on every signed-in page, and a
 * popup with the whole messaging feature inside it — conversation list,
 * directory search, and a live thread.
 *
 * Nothing here is a lesser version of the full page at /messages: both mount
 * the same MessageThread against the same server actions. The popup is for
 * answering someone without losing your place; the page is for when you want
 * room.
 */

type View = { kind: "list" } | { kind: "search" } | { kind: "thread"; thread: ThreadPayload };

const OPEN_KEY = "batch0:chat-dock-open";

export function ChatWidget({ viewerId }: { viewerId: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  const [rows, setRows] = useState<DmInboxRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Restore the last open/closed state so moving between pages doesn't slam
  // the dock shut mid-conversation. Wrapped because storage throws in a
  // private window with site data blocked, and the dock must still render.
  useEffect(() => {
    try {
      if (localStorage.getItem(OPEN_KEY) === "1") setOpen(true);
    } catch {
      /* no persistence available; default closed */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [open]);

  const refresh = useCallback(async () => {
    try {
      const [inbox, count] = await Promise.all([fetchInbox(), fetchUnreadCount()]);
      setRows(inbox);
      setUnread(count);
      setError(null);
    } catch {
      setError("Couldn't load your messages.");
    } finally {
      setLoading(false);
    }
  }, []);

  // The badge has to be right whether or not the dock is open, so the count
  // loads on mount rather than on first open.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // A direct-message bell for this user means some conversation just went
  // unread — see useInboxLive.
  useInboxLive(refresh);

  // Safety net for a dropped realtime connection, and cheap: two indexed
  // reads. Mirrors the notification bell's 60s poll.
  useEffect(() => {
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Reopening should show anything that arrived while it was shut.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Escape backs out one level rather than closing the whole dock from
      // inside a thread — losing your place is worse than one extra keypress.
      if (view.kind === "list") setOpen(false);
      else setView({ kind: "list" });
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, view.kind]);

  const openConversation = useCallback(async (id: string) => {
    try {
      const thread = await fetchThread({ conversationId: id });
      setView({ kind: "thread", thread });
    } catch {
      setError("That conversation isn't available.");
      setView({ kind: "list" });
    }
  }, []);

  const openWithPerson = useCallback(async (person: DmPerson) => {
    try {
      const thread = await fetchThread({ withUserId: person.id });
      setView({ kind: "thread", thread });
    } catch {
      setError("Couldn't open that conversation.");
      setView({ kind: "list" });
    }
  }, []);

  // The full page is the same feature with more room; a launcher floating over
  // it would just cover the thread.
  if (pathname?.startsWith("/messages")) return null;

  return (
    <>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Messages"
          className="fixed bottom-0 right-0 z-[55] flex h-[min(34rem,100dvh)] w-full flex-col overflow-hidden border border-line bg-paper shadow-[0_30px_60px_-15px_rgba(20,20,20,0.35)] sm:bottom-20 sm:right-5 sm:h-[32rem] sm:w-[22rem] sm:rounded-2xl"
        >
          <div className="flex items-center justify-between border-b border-line bg-wash px-3 py-2">
            <div className="flex items-center gap-2">
              <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                Messages
              </p>
              {unread > 0 && (
                <span className="rounded-full bg-phosphor/15 px-1.5 text-[10px] font-medium text-phosphor-ink">
                  {unread}
                </span>
              )}
            </div>
            <div className="flex items-center gap-0.5">
              {view.kind !== "search" && (
                <button
                  type="button"
                  onClick={() => setView({ kind: "search" })}
                  aria-label="New message"
                  className="press flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink"
                >
                  <MessageSquarePlus className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Minimize messages"
                className="press flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink"
              >
                <ChevronDown className="hidden h-4 w-4 sm:block" />
                <X className="h-4 w-4 sm:hidden" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            {view.kind === "thread" ? (
              <MessageThread
                viewerId={viewerId}
                initial={view.thread}
                compact
                onChanged={refresh}
                onBack={() => setView({ kind: "list" })}
              />
            ) : view.kind === "search" ? (
              <PeopleSearch
                compact
                onPick={openWithPerson}
                onCancel={() => setView({ kind: "list" })}
              />
            ) : (
              <div className="flex h-full flex-col">
                {error && (
                  <p role="alert" className="px-3 py-2 text-xs text-red-400">
                    {error}
                  </p>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <ConversationList
                    rows={rows}
                    loading={loading}
                    compact
                    onOpen={openConversation}
                    onNew={() => setView({ kind: "search" })}
                  />
                </div>
                <div className="border-t border-line bg-wash px-3 py-2">
                  <Link
                    href="/messages"
                    prefetch={false}
                    className="text-xs font-medium text-ink-soft transition hover:text-ink"
                  >
                    Open all messages →
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Messages (${unread} unread)` : "Messages"}
        aria-expanded={open}
        // Sits above the mobile panel's own header when closed, and out of the
        // way of it when open.
        className={`fixed bottom-5 right-5 z-[56] flex h-12 w-12 items-center justify-center rounded-full bg-phosphor text-on-phosphor shadow-cta transition active:scale-[0.96] ${
          open ? "hidden sm:flex" : "flex"
        }`}
      >
        <MessageCircle className="h-5 w-5" />
        {unread > 0 && !open && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-[20px] items-center justify-center rounded-full border-2 border-paper bg-red-500 px-1 text-[10px] font-bold leading-none text-[#fff]">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
    </>
  );
}
