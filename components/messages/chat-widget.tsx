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
 *
 * Stacking: z-[45]/z-[46] sits above page chrome (the z-30 bottom bars, the
 * z-40 sticky header) and below every modal layer (the z-50 mobile drawer,
 * the z-60 bell dropdown, z-100 dialogs), so it never covers a menu's Sign out
 * or a confirm. A page with a bottom action bar marks it `data-bottom-bar`,
 * and the launcher and panel lift clear of it.
 */

type View = { kind: "list" } | { kind: "search" } | { kind: "thread"; thread: ThreadPayload };

const OPEN_KEY = "batch0:chat-dock-open";

/**
 * Routes where the dock doesn't belong: the full messaging page (a launcher
 * over it would just cover the thread) and the live rooms, which are
 * full-screen and put their own controls, chat and Q&A exactly where the dock
 * would sit.
 */
function dockHiddenOn(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname.startsWith("/messages") || /\/live(\/|$)/.test(pathname);
}

/**
 * On a phone the open panel is a bottom sheet. The on-screen keyboard shrinks
 * the VISUAL viewport but not the layout one, so a sheet sized to 100dvh ends
 * up with its header pushed off the top. This sizes it to what's visible.
 */
function useVisualViewportSheet(active: boolean): React.CSSProperties | undefined {
  const [style, setStyle] = useState<React.CSSProperties | undefined>(undefined);
  useEffect(() => {
    if (!active) {
      setStyle(undefined);
      return;
    }
    const vv = window.visualViewport;
    const mq = window.matchMedia("(min-width: 640px)");
    const update = () => {
      if (!vv || mq.matches) {
        setStyle(undefined);
        return;
      }
      const bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setStyle({ height: Math.min(vv.height, 34 * 16), bottom });
    };
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    mq.addEventListener("change", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      mq.removeEventListener("change", update);
    };
  }, [active]);
  return style;
}

export function ChatWidget({ viewerId }: { viewerId: string }) {
  const pathname = usePathname();
  const hidden = dockHiddenOn(pathname);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  const [rows, setRows] = useState<DmInboxRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  // Only the latest open request may change the view: a slow fetch must not
  // yank the viewer out of wherever they've moved to since.
  const requestRef = useRef(0);
  const sheetStyle = useVisualViewportSheet(open && !hidden);

  // Restore the last open/closed state so moving between pages doesn't slam
  // the dock shut mid-conversation — on a wide screen, where it's a small
  // corner panel. On a phone it's a sheet over the whole page, so a new page
  // starts with it closed. Wrapped because storage throws in a private window
  // with site data blocked, and the dock must still render.
  useEffect(() => {
    try {
      if (
        localStorage.getItem(OPEN_KEY) === "1" &&
        window.matchMedia("(min-width: 640px)").matches
      ) {
        setOpen(true);
      }
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

  const openConversation = useCallback(async (id: string) => {
    const req = ++requestRef.current;
    try {
      const thread = await fetchThread({ conversationId: id });
      if (req !== requestRef.current) return;
      setView({ kind: "thread", thread });
    } catch {
      if (req !== requestRef.current) return;
      setError("That conversation isn't available.");
      setView({ kind: "list" });
    }
  }, []);

  const openWithPerson = useCallback(async (person: DmPerson) => {
    const req = ++requestRef.current;
    try {
      const thread = await fetchThread({ withUserId: person.id });
      if (req !== requestRef.current) return;
      setView({ kind: "thread", thread });
    } catch {
      if (req !== requestRef.current) return;
      setError("You can't message that person right now.");
      setView({ kind: "list" });
    }
  }, []);

  const showList = useCallback(() => {
    requestRef.current++;
    setView({ kind: "list" });
  }, []);

  // Reopening shows anything that arrived while it was shut — including in
  // the thread it was left on, which would otherwise come back as the copy
  // from before it was minimized, with the new messages missing.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    if (!open) return;
    refresh();
    const v = viewRef.current;
    if (v.kind === "thread") {
      if (v.thread.conversationId) openConversation(v.thread.conversationId);
      else openWithPerson(v.thread.other);
    }
  }, [open, refresh, openConversation, openWithPerson]);

  // Focus moves into the panel when it opens, and back to the launcher when
  // it closes — otherwise a keyboard or screen-reader user is left behind on
  // the launcher, or on nothing at all once the phone sheet covers it.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        panelRef.current
          ?.querySelector<HTMLElement>("textarea, input, button:not([aria-hidden])")
          ?.focus();
      });
    } else if (wasOpen.current) {
      launcherRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Not ours: an IME cancelling a composition, a layer inside the thread
      // that already handled it (its options menu), a dialog on top (block,
      // report — or any other modal on the page), or focus somewhere else.
      if (e.isComposing || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (!panelRef.current?.contains(document.activeElement)) return;
      // Escape backs out one level rather than closing the whole dock from
      // inside a thread — losing your place is worse than one extra keypress.
      if (viewRef.current.kind === "list") setOpen(false);
      else showList();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, showList]);

  if (hidden) return null;

  const closeForNavigation = () => setOpen(false);

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Messages (${unread} unread)` : "Messages"}
        aria-expanded={open}
        aria-controls="chat-dock-panel"
        // Hidden on a phone while the sheet is open (the sheet has its own
        // close button in the same corner); lifted over a page's bottom bar.
        className={`fixed bottom-[calc(1.25rem+var(--safe-bottom))] right-5 z-[46] h-12 w-12 items-center justify-center rounded-full bg-phosphor text-on-phosphor shadow-cta transition active:scale-[0.96] [body:has([data-bottom-bar])_&]:bottom-[calc(5.5rem+var(--safe-bottom))] ${
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

      {open && (
        <div
          id="chat-dock-panel"
          ref={panelRef}
          role="dialog"
          aria-label="Messages"
          style={sheetStyle}
          className="fixed bottom-0 right-0 z-[45] flex h-[min(34rem,100dvh)] w-full flex-col overflow-hidden border border-line bg-paper pb-[var(--safe-bottom)] shadow-[0_30px_60px_-15px_rgba(20,20,20,0.35)] sm:bottom-20 sm:right-5 sm:h-[min(32rem,calc(100dvh-6rem))] sm:w-[22rem] sm:rounded-2xl sm:pb-0 sm:[body:has([data-bottom-bar])_&]:bottom-[8.25rem] sm:[body:has([data-bottom-bar])_&]:h-[min(32rem,calc(100dvh-10rem))]"
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
                  onClick={() => {
                    requestRef.current++;
                    setView({ kind: "search" });
                  }}
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
                onBack={showList}
                onNavigateAway={closeForNavigation}
              />
            ) : view.kind === "search" ? (
              <PeopleSearch compact onPick={openWithPerson} onCancel={showList} />
            ) : (
              <div className="flex h-full flex-col">
                {error && rows.length > 0 && (
                  <p role="alert" className="px-3 py-2 text-xs text-red-400">
                    {error}
                  </p>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                  <ConversationList
                    rows={rows}
                    loading={loading}
                    error={rows.length === 0 ? error : null}
                    onRetry={() => {
                      setLoading(true);
                      refresh();
                    }}
                    compact
                    onOpen={openConversation}
                    onNew={() => setView({ kind: "search" })}
                  />
                </div>
                <div className="border-t border-line bg-wash px-3 py-2">
                  <Link
                    href="/messages"
                    prefetch={false}
                    onClick={closeForNavigation}
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
    </>
  );
}
