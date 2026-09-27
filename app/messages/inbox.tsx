"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquarePlus, MessagesSquare } from "lucide-react";
import type { DmInboxRow, DmPerson } from "@/lib/dm";
import type { ThreadPayload } from "@/lib/dm-thread";
import { fetchInbox, fetchThread } from "./actions";
import { BlockedList } from "@/components/messages/blocked-list";
import { ConversationList } from "@/components/messages/conversation-list";
import { MessageThread } from "@/components/messages/message-thread";
import { PeopleSearch } from "@/components/messages/people-search";
import { useInboxLive } from "@/components/messages/use-dm-live";

/**
 * The full page: list on the left, conversation on the right. On a phone it's
 * one pane at a time — the list until you pick someone, the thread after.
 *
 * The thread the page was rendered with is the starting state; switching
 * conversations after that fetches through the same action the popup uses
 * instead of navigating, so the list doesn't flash and the scroll position on
 * the left survives.
 */
export function MessagesInbox({
  viewerId,
  initialRows,
  initialError = null,
  initialThread,
}: {
  viewerId: string;
  initialRows: DmInboxRow[];
  initialError?: string | null;
  initialThread: ThreadPayload | null;
}) {
  const [rows, setRows] = useState(initialRows);
  const [thread, setThread] = useState(initialThread);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(initialError);

  const refresh = useCallback(async () => {
    try {
      setRows(await fetchInbox());
      setListError(null);
    } catch {
      // The list keeps what it has; the next tick retries.
      setListError("Couldn't load your conversations.");
    }
  }, []);

  // A draft's first message created the conversation: adopt its id, so the
  // list row it now has is the SAME thread (clicking it doesn't reload and
  // wipe a half-typed reply) and a reload lands back here.
  const onConversationCreated = useCallback((conversationId: string) => {
    setThread((t) => (t ? { ...t, conversationId } : t));
    window.history.replaceState(null, "", `/messages?c=${conversationId}`);
  }, []);

  // Opening the row of the thread already on screen is a no-op.
  const threadRef = useRef(thread);
  threadRef.current = thread;

  useInboxLive(refresh);

  useEffect(() => {
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const open = useCallback(
    async (conversationId: string) => {
      setSearching(false);
      setError(null);
      if (threadRef.current?.conversationId === conversationId) return;
      try {
        setThread(await fetchThread({ conversationId }));
        // Keep the URL honest so a reload, a bookmark, or a back button lands
        // on the same conversation.
        window.history.replaceState(null, "", `/messages?c=${conversationId}`);
      } catch {
        setError("That conversation isn't available.");
      }
    },
    [],
  );

  const openWith = useCallback(async (person: DmPerson) => {
    setSearching(false);
    setError(null);
    try {
      const next = await fetchThread({ withUserId: person.id });
      setThread(next);
      window.history.replaceState(
        null,
        "",
        next.conversationId ? `/messages?c=${next.conversationId}` : `/messages?to=${person.id}`,
      );
    } catch {
      setError("Couldn't open that conversation.");
    }
  }, []);

  // A send in a draft thread creates the conversation, and any send or read
  // changes the list. Only the list — the client owns both panes from here, so
  // a router.refresh() would re-render the server page for nothing.
  const onChanged = refresh;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden border-line md:rounded-2xl md:border">
      {/* Left: list. Hidden on a phone once a thread is open. */}
      <aside
        className={`flex w-full min-w-0 flex-col border-line md:flex md:w-80 md:shrink-0 md:border-r ${
          thread ? "hidden md:flex" : "flex"
        }`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h1 className="text-sm font-semibold text-ink">Conversations</h1>
          <button
            type="button"
            onClick={() => setSearching(true)}
            className="press inline-flex items-center gap-1.5 text-xs font-medium text-phosphor-ink hover:opacity-80"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            New
          </button>
        </div>
        {error && (
          <p role="alert" className="px-4 py-2 text-xs text-red-400">
            {error}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ConversationList
            rows={rows}
            activeId={thread?.conversationId ?? null}
            onOpen={open}
            onNew={() => setSearching(true)}
            error={listError}
            onRetry={refresh}
          />
        </div>
        <BlockedList />
      </aside>

      {/* Right: search, thread, or an empty state. */}
      <section
        className={`min-h-0 min-w-0 flex-1 flex-col ${thread || searching ? "flex" : "hidden md:flex"}`}
      >
        {searching ? (
          <PeopleSearch onPick={openWith} onCancel={() => setSearching(false)} />
        ) : thread ? (
          <MessageThread
            viewerId={viewerId}
            initial={thread}
            onChanged={onChanged}
            onConversationCreated={onConversationCreated}
            // Phone-only: on desktop the list never went away.
            backMobileOnly
            onBack={() => {
              setThread(null);
              window.history.replaceState(null, "", "/messages");
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-wash">
              <MessagesSquare className="h-4 w-4 text-ink-faint" />
            </div>
            <p className="mt-4 text-sm text-ink-soft">Pick a conversation</p>
            <p className="mt-1 max-w-xs text-xs text-ink-faint">
              Or start a new one — you can message anyone with a batch0 account.
            </p>
            <button
              type="button"
              onClick={() => setSearching(true)}
              className="press mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-phosphor-ink hover:opacity-80"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              New message
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
