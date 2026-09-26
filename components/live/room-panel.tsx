"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import {
  MAX_QUESTION_LENGTH,
  normalizeQuestion,
  type QuestionStatus,
  type WebinarQuestion,
} from "@/lib/live";
import {
  ROOM_BUMP_DEBOUNCE_MS,
  ROOM_RESYNC_MS,
  SIGNAL_EVENT,
  type RoomMessage,
} from "@/lib/live-signal";
import {
  audienceCanSeeEachOther,
  chatMessageIsLive,
  isReaction,
  normalizeChatMessage,
  normalizePoll,
  pollPercentages,
  MAX_CHAT_LENGTH,
  MAX_POLL_OPTIONS,
  MAX_POLL_OPTION_LENGTH,
  MAX_POLL_QUESTION_LENGTH,
  REACTIONS,
  REACTION_RATE_PER_SECOND,
  type AudienceMode,
  type ChatMessage,
  type WebinarPoll,
} from "@/lib/webinars";
import {
  approveQuestion,
  createPoll,
  fetchRoomState,
  moderateChatMessage,
  sendChatMessage,
  setPollOpen,
  setQuestionStatus,
  spotlightQuestion,
  voteOnPoll,
  voteOnQuestion,
  type RoomState,
} from "@/app/dashboard/events/[id]/live/room-actions";
import { askQuestion } from "@/app/dashboard/events/[id]/live/actions";
import {
  AlertTriangle,
  ArrowBigUp,
  BarChart3,
  Check,
  ChevronDown,
  MessageCircleQuestion,
  MessageSquare,
  Pin,
  PinOff,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

/**
 * Everything in a webinar that isn't video: chat, the question queue, polls
 * and reactions.
 *
 * This is the richer sibling of qa-panel.tsx, not its replacement. That panel
 * is still exactly right where a room has nothing but a question queue — a 1:1
 * call, and a webinar in `private` mode, where the audience genuinely cannot
 * see itself and a chat tab would be a lie with a disabled button on it. The
 * room picks between the two; neither knows about the other.
 *
 * ---------------------------------------------------------------------------
 * Why this does not poll
 * ---------------------------------------------------------------------------
 *
 * The old panel polled `fetchQuestions` every 5s for a host and every 15s for
 * a viewer. That is a per-person cost multiplied by the size of the audience,
 * and a webinar is the one place the multiplier is large: fifty students at 5s
 * is 600 requests a minute against a table that changes a few times an hour,
 * for a room where nothing is happening most of the time.
 *
 * So the cadence is inverted. The room's Realtime channel says when something
 * changed, and only then is anything re-read:
 *
 *   `creds.roomTopic`        every participant who is allowed one. Carries
 *                            `bump` (re-read), `react` (draw and forget), and
 *                            `stage-change` (handed up — see below).
 *   `creds.moderationTopic`  hosts only. The same bumps, for items the
 *                            audience has not been shown yet.
 *
 * Two safety nets sit under that, and both are load-bearing rather than
 * belt-and-braces:
 *
 *   A burst is debounced by ROOM_BUMP_DEBOUNCE_MS. Five messages in a busy
 *   second arrive as five bumps, and without the debounce that is five queries
 *   per client per second — the exact pile-up the old polling design was
 *   written to avoid, reintroduced through the front door.
 *
 *   Everything is re-read unconditionally every ROOM_RESYNC_MS. Realtime
 *   broadcasts are NOT replayed: a message published while this component was
 *   between subscriptions is simply gone, and a bump that is gone is a chat
 *   message that never appears for exactly one person and appears for everyone
 *   else. That is the class of bug nobody can reproduce, so it is repaired on a
 *   timer instead of being argued about.
 *
 * The visibility behaviour from the old panel is kept because it was right: a
 * hidden tab learns nothing from a resync, so the timer stops on
 * `document.hidden` and fires once immediately on return.
 *
 * ---------------------------------------------------------------------------
 * Why a bump carries no content, and why a forged one is harmless
 * ---------------------------------------------------------------------------
 *
 * Read the note on `RoomMessage` in lib/live-signal.ts; this is its client
 * half. Nothing substantive crosses the room channel — not the message body,
 * not the author, not the tally. A bump is a content-free ping, and the answer
 * to one is a server action that reads under the CALLER'S OWN RLS.
 *
 * It is that way because every participant holds the room key. Anything one
 * participant could verify, another could mint, so a signed payload would prove
 * nothing here (it works on the stage channel precisely because hosts publish
 * and viewers only listen). Given that, the honest design is to publish
 * something not worth forging: the worst a student in devtools achieves on this
 * channel is making the room re-read, and a re-read returns exactly what that
 * reader was already entitled to see. Against the 5-second poll this replaces,
 * a forged bump is indistinguishable from an ordinary tick.
 *
 * The one exception is `react`, which is published straight from the browser
 * with no server round trip — that IS the feature — and is never stored.
 * `isReaction` is the entire alphabet, so a forged one puts a clap on some
 * screens for two seconds.
 *
 * ---------------------------------------------------------------------------
 * Audience privacy
 * ---------------------------------------------------------------------------
 *
 * In `private` mode a viewer must learn nothing about any other viewer, and
 * that guarantee is not enforced here — the server never sends the data, and a
 * viewer is not even given `roomTopic`, so there is no channel on which another
 * student could be observed. What this file must not do is assume otherwise:
 * every audience-shaped affordance (the whole Chat tab, upvote buttons,
 * reactions) is behind `audienceCanSeeEachOther`, and in `private` the Chat tab
 * does not exist rather than existing greyed out. A disabled button is still a
 * disclosure that there is something to be disabled.
 *
 * ---------------------------------------------------------------------------
 * `stage-change`, and why End is not here
 * ---------------------------------------------------------------------------
 *
 * `stage-change` (go-live, End, Reopen) is not acted on here: it is handed to
 * the room (`onStageChange`), which owns the video and re-asks the server.
 * Two components racing to switch the stage is how an audience ends up half on
 * the recording and half on the camera.
 *
 * This panel used to carry its own End and Reopen buttons. Its End only
 * stamped the row, so the host who pressed it kept broadcasting — camera, mic
 * and recorder still live to every viewer — under an "Ended" badge, and its
 * Reopen kept a second copy of the ended state that drifted from the room's.
 * There is now exactly one End (the room's control bar, which flushes the
 * recording and tears the session down) and one Reopen (the host's ended
 * screen). The panel is told the ended state as a prop, reports what the
 * server says upward, and keeps no copy of its own.
 *
 * After End the room is closed to the audience: composers, votes and
 * reactions are withdrawn for non-moderators (the server refuses those writes
 * too). Moderators keep everything, for a closing note or a last answer.
 */

type PanelTab = "chat" | "questions" | "polls";

/**
 * A question row, read defensively.
 *
 * `WebinarQuestion` in lib/live.ts has no `voteCount`, `spotlighted` or
 * `approvedAt` — migration 0084 added those columns, but the shared type and
 * the reads in lib/webinar-questions.ts predate them and are shared with the
 * 1:1 surface, so widening the type there would be a change to a file this
 * panel has no business touching. They are therefore optional here and every
 * read of them has a fallback: a build whose server does not send `voteCount`
 * shows an honest 0 rather than `NaN`, and one that does not send `approvedAt`
 * simply offers Approve to a moderator, which is idempotent.
 */
type RoomQuestion = WebinarQuestion & {
  voteCount?: number;
  spotlighted?: boolean;
  approvedAt?: string | null;
};

/** One emoji in flight up the panel. Never stored, never sent to a server. */
type FloatingReaction = { key: number; emoji: string; left: number };

/** A message the user has sent that the server has not confirmed yet. */
type OutboxMessage = { key: number; body: string; failed: boolean };

const NEAR_BOTTOM_PX = 80;
/** Most floating emoji on screen at once. A spam burst must not lock the tab. */
const MAX_FLOATING_REACTIONS = 20;
const REACTION_LIFETIME_MS = 2000;

export function RoomPanel({
  eventId,
  isModerator,
  audienceMode,
  initial,
  roomTopic,
  moderationTopic,
  liveEndedAt,
  onServerState,
  onStageChange,
}: {
  eventId: string;
  /** Derived server-side from events.manage OR a guest-speaker row. */
  isModerator: boolean;
  audienceMode: AudienceMode;
  initial: RoomState;
  /** Realtime topics from the join payload. null when this participant has none. */
  roomTopic: string | null;
  moderationTopic: string | null;
  /** When the webinar was ended for everyone, as the ROOM knows it. */
  liveEndedAt: string | null;
  /**
   * What every read of the room told us about End and who may press it. The
   * room decides what to do with it (an `ended` here starts its teardown).
   */
  onServerState?: (state: { liveEndedAt: string | null; canEnd: boolean }) => void;
  /** `stage-change` arrived on the room channel — the room re-checks. */
  onStageChange?: () => void;
}) {
  const chatty = audienceCanSeeEachOther(audienceMode);
  /** After End, the audience can read but no longer write. */
  const closedToAudience = liveEndedAt !== null && !isModerator;

  const [chat, setChat] = useState<ChatMessage[]>(initial.chat);
  const [pinned, setPinned] = useState<ChatMessage | null>(initial.pinned);
  const [questions, setQuestions] = useState<RoomQuestion[]>(initial.questions);
  const [polls, setPolls] = useState<WebinarPoll[]>(initial.polls);
  const [error, setError] = useState<string | null>(null);

  // In `private` mode there is no Chat tab at all, so the queue is where
  // everyone starts. Elsewhere chat is the busiest surface and the one people
  // expect to land on.
  const [tab, setTab] = useState<PanelTab>(chatty ? "chat" : "questions");
  const [badges, setBadges] = useState<Record<PanelTab, number>>({
    chat: 0,
    questions: 0,
    polls: 0,
  });

  // Mirrors of the lists, for the apply path. A refresh has to diff against
  // what is already on screen to know what is NEW (for the tab badges), and
  // doing that diff inside a setState updater would make the updater impure —
  // React may call it twice in development and the badge would double-count.
  const chatRef = useRef(chat);
  const questionsRef = useRef(questions);
  const pollsRef = useRef(polls);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  /** Newest chat timestamp the SERVER has confirmed. Never advanced locally. */
  const cursorRef = useRef<string | null>(initial.cursor);

  // Read through refs by the apply path and the channel handler, which must
  // not change identity (see the subscription note below).
  const onServerStateRef = useRef(onServerState);
  onServerStateRef.current = onServerState;
  const onStageChangeRef = useRef(onStageChange);
  onStageChangeRef.current = onStageChange;

  /**
   * Fold a fresh read into what is on screen.
   *
   * `full` is the difference between "append what is new" and "this is the
   * truth now", and it matters more than it looks. An incremental read asks the
   * server for messages after the cursor, so it can never carry a change to an
   * OLDER message — an approval, a pin, a removal. Applying one of those as a
   * merge would leave a message the host has taken down still on screen for
   * everybody who was already watching. So a full read REPLACES the list, and
   * anything that could have changed history asks for one.
   */
  const apply = useCallback((next: RoomState, full: boolean) => {
    setError(null);

    const prevChat = chatRef.current;
    const nextChat = full ? next.chat : mergeChat(prevChat, next.chat);
    const knownChat = new Set(prevChat.map((m) => m.id));
    // "You" is how every server read names the reader's own rows, so this also
    // keeps the badge from counting the message you just sent yourself.
    const freshChat = nextChat.filter(
      (m) => !knownChat.has(m.id) && m.authorName !== "You",
    );
    chatRef.current = nextChat;
    setChat(nextChat);
    setPinned(next.pinned);

    const prevQuestions = questionsRef.current;
    const knownQuestions = new Set(prevQuestions.map((q) => q.id));
    const freshQuestions = next.questions.filter(
      (q) => !knownQuestions.has(q.id) && q.askerName !== "You",
    );
    questionsRef.current = next.questions;
    setQuestions(next.questions);

    // A poll only counts as news when it OPENS. A moderator drafting three
    // polls before the talk should not light up their own badge.
    const wasOpen = new Set(
      pollsRef.current.filter((p) => p.open).map((p) => p.id),
    );
    const freshPolls = next.polls.filter((p) => p.open && !wasOpen.has(p.id));
    pollsRef.current = next.polls;
    setPolls(next.polls);

    // Only the server's cursor is ever stored. Advancing it from a locally
    // echoed message would skip anything written between the two timestamps.
    if (next.cursor) cursorRef.current = next.cursor;

    const active = tabRef.current;
    setBadges((b) => ({
      chat: active === "chat" ? 0 : b.chat + freshChat.length,
      questions:
        active === "questions" ? 0 : b.questions + freshQuestions.length,
      polls: active === "polls" ? 0 : b.polls + freshPolls.length,
    }));

    // Every read reports, not just the first "ended" — there is no latch to
    // forget to reset after a Reopen.
    onServerStateRef.current?.({
      liveEndedAt: next.liveEndedAt,
      canEnd: next.canEnd,
    });
  }, []);

  // Guards against pile-up: on a slow connection a resync can fire again
  // before the previous request has answered, and each one is a server action
  // hitting the database. A full read that arrives while one is in flight is
  // remembered rather than dropped — it is the read that repairs moderation.
  const inFlight = useRef(false);
  const queuedFull = useRef(false);
  const refreshRef = useRef<(full?: boolean) => void>(() => {});

  const refresh = useCallback(
    async (full = false) => {
      if (inFlight.current) {
        queuedFull.current = queuedFull.current || full;
        return;
      }
      inFlight.current = true;
      try {
        const next = await fetchRoomState(
          eventId,
          full ? null : cursorRef.current,
        );
        // Null means the gate said no — the join window closed under us, or the
        // session expired. Nothing useful to draw, and nothing worth alarming
        // anyone about mid-talk; the next resync will say the same thing.
        if (next) apply(next, full);
      } catch (e: any) {
        setError(getActionError(e));
      } finally {
        inFlight.current = false;
        if (queuedFull.current) {
          queuedFull.current = false;
          refreshRef.current(true);
        }
      }
    },
    [eventId, apply],
  );
  refreshRef.current = (full = false) => void refresh(full);

  // --- reactions -----------------------------------------------------------

  const [floating, setFloating] = useState<FloatingReaction[]>([]);
  const reactionKey = useRef(0);
  const reactionTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const sentReactions = useRef<number[]>([]);

  /**
   * Put one emoji on screen and forget it.
   *
   * Capped at MAX_FLOATING_REACTIONS because the publishing side is rate
   * limited only in the browser (deliberately — see REACTION_RATE_PER_SECOND),
   * so a determined student CAN send faster than the limit. The cap is what
   * makes that cost a busier animation rather than a tab full of elements that
   * stops responding to the person trying to read chat.
   */
  const pushReaction = useCallback((emoji: string) => {
    const key = (reactionKey.current += 1);
    setFloating((prev) => {
      const next = [...prev, { key, emoji, left: 6 + Math.random() * 70 }];
      return next.length > MAX_FLOATING_REACTIONS
        ? next.slice(next.length - MAX_FLOATING_REACTIONS)
        : next;
    });
    const timer = setTimeout(() => {
      reactionTimers.current.delete(timer);
      setFloating((prev) => prev.filter((r) => r.key !== key));
    }, REACTION_LIFETIME_MS);
    reactionTimers.current.add(timer);
  }, []);

  useEffect(() => {
    const timers = reactionTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Read through a ref by the channel handler below, for the same reason the
  // handler itself is: the subscription must not depend on anything that
  // changes identity, or it re-subscribes and doubles every bump.
  const pushReactionRef = useRef(pushReaction);
  pushReactionRef.current = pushReaction;

  // --- transport -----------------------------------------------------------

  /**
   * The debounce, held in a ref rather than state so a bump never causes a
   * render of its own. A bump is a reason to fetch, not news in itself.
   */
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpFull = useRef(false);

  const onRoomMessage = useCallback((message: RoomMessage) => {
    if (message.t === "react") {
      // Validated before anything reaches the DOM. The alphabet IS the
      // moderation for reactions — see the note on REACTIONS.
      if (isReaction(message.emoji)) pushReactionRef.current(message.emoji);
      return;
    }
    // `stage-change` belongs to the room that owns the video: hand it up, so
    // End or a go-live reaches the room now rather than on its poll. Acting
    // on it here as well would mean two components racing to switch the stage.
    if (message.t === "stage-change") {
      onStageChangeRef.current?.();
      return;
    }
    if (message.t !== "bump") return;

    /**
     * A bump WITH a cursor is a new row at the end of the feed, which an
     * incremental read covers. A bump WITHOUT one is the server saying
     * something changed that it could not point at — an approval, a pin, a
     * removal, a vote — and only a full read converges on those.
     */
    if (!("cursor" in message) || !message.cursor) bumpFull.current = true;
    if (bumpTimer.current) return;
    bumpTimer.current = setTimeout(() => {
      bumpTimer.current = null;
      const full = bumpFull.current;
      bumpFull.current = false;
      refreshRef.current(full);
    }, ROOM_BUMP_DEBOUNCE_MS);
  }, []);

  const onRoomMessageRef = useRef(onRoomMessage);
  onRoomMessageRef.current = onRoomMessage;

  /** The room channel, kept so a reaction can be published with no round trip. */
  const roomChannel = useRef<RealtimeChannel | null>(null);

  /**
   * One channel per topic, for the life of the component.
   *
   * realtime-js dedupes `channel(topic)` by topic and only removes an old entry
   * asynchronously, so a component that re-subscribed on every render would get
   * the SAME channel object back, register a second handler on it (two
   * dispatches per message, so every bump costs two queries), and then stall on
   * `subscribe()` of a channel that is mid-unsubscribe. use-live-session.ts
   * learned that the hard way; the fix there and here is the same — subscribe
   * once, keep it, and remove it in cleanup.
   *
   * The handler reads `onRoomMessageRef` rather than closing over the callback,
   * so the effect's dependencies are two strings that do not change.
   */
  useEffect(() => {
    if (!roomTopic && !moderationTopic) return;
    const supabase = createClient();
    const channels: RealtimeChannel[] = [];

    for (const topic of [roomTopic, moderationTopic]) {
      if (!topic) continue;
      const ch = supabase.channel(topic);
      ch.on("broadcast", { event: SIGNAL_EVENT }, (m) => {
        onRoomMessageRef.current(m.payload as RoomMessage);
      });
      ch.subscribe();
      channels.push(ch);
      if (topic === roomTopic) roomChannel.current = ch;
    }

    return () => {
      roomChannel.current = null;
      for (const ch of channels) void supabase.removeChannel(ch);
    };
  }, [roomTopic, moderationTopic]);

  /** The backstop. See the header: broadcasts are not replayed. */
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (timer === null) {
        timer = setInterval(() => refreshRef.current(true), ROOM_RESYNC_MS);
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        // Catch up immediately rather than making them wait out a full period
        // for whatever changed while the tab was in the background.
        refreshRef.current(true);
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(
    () => () => {
      if (bumpTimer.current) clearTimeout(bumpTimer.current);
    },
    [],
  );

  /**
   * Publish a reaction straight onto the room channel.
   *
   * No server action, and that is the whole point: a clap that costs a round
   * trip is a clap that lands after the moment it was reacting to. The local
   * echo is immediate for the same reason.
   */
  const sendReaction = useCallback(
    (emoji: string) => {
      const now = Date.now();
      sentReactions.current = sentReactions.current.filter(
        (t) => now - t < 1000,
      );
      if (sentReactions.current.length >= REACTION_RATE_PER_SECOND) return;
      sentReactions.current.push(now);
      pushReaction(emoji);
      const payload: RoomMessage = { t: "react", emoji };
      void roomChannel.current
        ?.send({ type: "broadcast", event: SIGNAL_EVENT, payload })
        .catch(() => {
          // A dropped reaction is a clap nobody saw. There is nothing to retry
          // and nothing worth telling anyone about.
        });
    },
    [pushReaction],
  );

  // --- chat ----------------------------------------------------------------

  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const outboxKey = useRef(0);

  const onSendChat = useCallback(
    async (raw: string) => {
      const body = normalizeChatMessage(raw);
      if (!body) return;
      const key = (outboxKey.current += 1);
      setOutbox((o) => [...o, { key, body, failed: false }]);
      try {
        const created = await sendChatMessage(eventId, body);
        // The real row replaces the optimistic one in a single commit, so the
        // message never flickers out of the list between the two.
        setOutbox((o) => o.filter((m) => m.key !== key));
        chatRef.current = mergeChat(chatRef.current, [created]);
        setChat(chatRef.current);
      } catch (e: any) {
        setError(getActionError(e));
        setOutbox((o) =>
          o.map((m) => (m.key === key ? { ...m, failed: true } : m)),
        );
      }
    },
    [eventId],
  );

  const onModerateChat = useCallback(
    async (messageId: string, action: "approve" | "remove" | "pin" | "unpin") => {
      // Optimistic: move it now, reconcile on the full read. Same shape as
      // qa-panel's onModerate — the host is working a queue and every one of
      // these is a decision they have already made.
      chatRef.current = chatRef.current
        .map((m) =>
          m.id === messageId
            ? {
                ...m,
                approvedAt:
                  action === "approve"
                    ? new Date().toISOString()
                    : m.approvedAt,
                pinned: action === "pin" ? true : action === "unpin" ? false : m.pinned,
              }
            : action === "pin"
              ? // One pin at a time, locally too: the server clears the old one
                // and a client that did not would show two sticky strips until
                // the next read.
                { ...m, pinned: false }
              : m,
        )
        .filter((m) => !(action === "remove" && m.id === messageId));
      setChat(chatRef.current);
      if (action === "unpin") setPinned(null);
      try {
        await moderateChatMessage(eventId, messageId, action);
      } catch (e: any) {
        setError(getActionError(e));
      }
      // Full, not incremental: this changed a message that is already behind
      // the cursor, which an incremental read cannot see.
      refreshRef.current(true);
    },
    [eventId],
  );

  // --- questions -----------------------------------------------------------

  /**
   * Questions this reader has upvoted, for this session only.
   *
   * The server does not return the reader's own votes (`WebinarQuestion` has no
   * such field and the reads that build it never joined the votes table), so
   * there is nothing to restore on a reload — the count is authoritative, this
   * is only what draws the button as pressed. `voteOnQuestion` is idempotent in
   * both directions, so the worst a forgotten vote costs is an upvote the
   * student has to press twice after a refresh.
   */
  const [myVotes, setMyVotes] = useState<Set<string>>(new Set());

  const onVoteQuestion = useCallback(
    async (questionId: string, on: boolean) => {
      setMyVotes((prev) => {
        const next = new Set(prev);
        if (on) next.add(questionId);
        else next.delete(questionId);
        return next;
      });
      questionsRef.current = questionsRef.current.map((q) =>
        q.id === questionId
          ? { ...q, voteCount: Math.max(0, (q.voteCount ?? 0) + (on ? 1 : -1)) }
          : q,
      );
      setQuestions(questionsRef.current);
      try {
        await voteOnQuestion(eventId, questionId, on);
      } catch (e: any) {
        setError(getActionError(e));
      }
      refreshRef.current(true);
    },
    [eventId],
  );

  const onAsked = useCallback((q: WebinarQuestion) => {
    questionsRef.current = [...questionsRef.current, q];
    setQuestions(questionsRef.current);
  }, []);

  const onQuestionAction = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e: any) {
        // Surfaced rather than swallowed: a moderation click that did nothing
        // should say why (the window closed, the session expired).
        setError(getActionError(e));
      }
      refreshRef.current(true);
    },
    [],
  );

  // --- polls ---------------------------------------------------------------

  const onVotePoll = useCallback(
    async (pollId: string, choice: number) => {
      pollsRef.current = pollsRef.current.map((p) =>
        p.id === pollId ? { ...p, myChoice: choice } : p,
      );
      setPolls(pollsRef.current);
      try {
        await voteOnPoll(eventId, pollId, choice);
      } catch (e: any) {
        setError(getActionError(e));
      }
      refreshRef.current(true);
    },
    [eventId],
  );

  const onSetPollOpen = useCallback(
    async (pollId: string, open: boolean) => {
      pollsRef.current = pollsRef.current.map((p) =>
        p.id === pollId ? { ...p, open } : p,
      );
      setPolls(pollsRef.current);
      try {
        await setPollOpen(eventId, pollId, open);
      } catch (e: any) {
        setError(getActionError(e));
      }
      refreshRef.current(true);
    },
    [eventId],
  );

  // --- render --------------------------------------------------------------

  const tabs = useMemo(() => {
    const all: { id: PanelTab; label: string; icon: typeof MessageSquare }[] = [
      { id: "questions", label: "Questions", icon: MessageCircleQuestion },
      { id: "polls", label: "Polls", icon: BarChart3 },
    ];
    // In `private` mode the Chat tab does not exist. Not disabled, not empty —
    // absent, because a disabled tab is itself a statement that there are other
    // people in the room whose messages are being withheld.
    if (chatty) {
      all.unshift({ id: "chat", label: "Chat", icon: MessageSquare });
    }
    return all;
  }, [chatty]);

  const selectTab = useCallback((next: PanelTab) => {
    setTab(next);
    tabRef.current = next;
    setBadges((b) => ({ ...b, [next]: 0 }));
  }, []);

  return (
    <aside className="relative flex h-full flex-col overflow-hidden rounded-xl border border-line bg-wash">
      <ReactionStyles />

      <nav
        className="flex gap-1 overflow-x-auto border-b border-line bg-wash p-1"
        aria-label="Room panel"
      >
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          const badge = badges[t.id];
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => selectTab(t.id)}
              aria-current={active ? "page" : undefined}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                active
                  ? "bg-phosphor/15 text-phosphor-ink"
                  : "text-ink-soft hover:text-ink"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
              {!active && badge > 0 && (
                <span className="rounded-full bg-phosphor/15 px-1.5 text-[10px] tabular-nums text-phosphor-ink">
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {liveEndedAt && (
        <div className="border-b border-line bg-paper px-3 py-2 text-xs text-ink-soft">
          This webinar ended <LocalTime value={liveEndedAt} mode="time" />.
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 border-b border-line bg-amber-400/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs text-ink-soft">{error}</p>
        </div>
      )}

      {tab === "chat" && chatty && (
        <ChatTab
          messages={chat}
          outbox={outbox}
          pinned={pinned}
          audienceMode={audienceMode}
          isModerator={isModerator}
          closed={closedToAudience}
          onSend={onSendChat}
          onModerate={onModerateChat}
          onRetry={(key) => {
            const held = outbox.find((m) => m.key === key);
            setOutbox((o) => o.filter((m) => m.key !== key));
            if (held) void onSendChat(held.body);
          }}
        />
      )}

      {tab === "questions" && (
        <QuestionsTab
          eventId={eventId}
          questions={questions}
          isModerator={isModerator}
          canUpvote={chatty && !closedToAudience}
          closed={closedToAudience}
          myVotes={myVotes}
          onVote={onVoteQuestion}
          onAsked={onAsked}
          onAction={onQuestionAction}
          onError={setError}
        />
      )}

      {tab === "polls" && (
        <PollsTab
          eventId={eventId}
          polls={polls}
          isModerator={isModerator}
          closed={closedToAudience}
          onVote={onVotePoll}
          onSetOpen={onSetPollOpen}
          onCreated={() => refreshRef.current(true)}
          onError={setError}
        />
      )}

      {chatty && !closedToAudience && <ReactionBar onReact={sendReaction} />}

      <div
        className="pointer-events-none absolute inset-x-0 bottom-16 top-0 overflow-hidden"
        aria-hidden
      >
        {floating.map((r) => (
          <span
            key={r.key}
            className="b0-react absolute bottom-0 text-2xl"
            style={{ left: `${r.left}%` }}
          >
            {r.emoji}
          </span>
        ))}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function ChatTab({
  messages,
  outbox,
  pinned,
  audienceMode,
  isModerator,
  closed,
  onSend,
  onModerate,
  onRetry,
}: {
  messages: ChatMessage[];
  outbox: OutboxMessage[];
  pinned: ChatMessage | null;
  audienceMode: AudienceMode;
  isModerator: boolean;
  /** Ended: the audience reads, and no longer writes. */
  closed: boolean;
  onSend: (body: string) => Promise<void>;
  onModerate: (
    id: string,
    action: "approve" | "remove" | "pin" | "unpin",
  ) => void;
  onRetry: (key: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastCount = useRef(messages.length);
  const [unseen, setUnseen] = useState(0);

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setUnseen(0);
  }, []);

  /**
   * Follow the conversation, but never take the scroll away from someone.
   *
   * Auto-scrolling on every message is the classic chat bug: a student
   * scrolling back to re-read what the host said two minutes ago gets yanked to
   * the bottom every time anyone types, and the only way to read anything is to
   * leave. So the list follows only when they are already at the bottom, and
   * otherwise offers a button — which also tells them how much they have missed.
   */
  useEffect(() => {
    const added = messages.length - lastCount.current;
    lastCount.current = messages.length;
    if (added <= 0) return;
    if (atBottom.current) toBottom();
    else setUnseen((n) => n + added);
  }, [messages.length, toBottom]);

  // Anchor at the bottom on the first paint, so a room with an hour of history
  // opens on the newest message rather than on the first thing anyone said.
  useEffect(() => {
    toBottom();
  }, [toBottom]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance <= NEAR_BOTTOM_PX;
    if (atBottom.current) setUnseen(0);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {pinned && (
        <div className="flex items-start gap-2 border-b border-line bg-phosphor/10 px-3 py-2">
          <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-phosphor-ink" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-ink-faint">{pinned.authorName}</p>
            <p className="whitespace-pre-wrap break-words text-xs text-ink">
              {pinned.body}
            </p>
          </div>
          {isModerator && (
            <button
              type="button"
              onClick={() => onModerate(pinned.id, "unpin")}
              aria-label="Unpin this message"
              className="text-ink-faint hover:text-ink"
            >
              <PinOff className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Room chat"
          className="h-full overflow-y-auto px-3 py-3"
        >
          {messages.length === 0 && outbox.length === 0 ? (
            <p className="py-6 text-center text-xs text-ink-faint">
              Nobody has said anything yet. Say hello.
            </p>
          ) : (
            <ul className="space-y-2">
              {messages.map((m) => (
                <ChatRow
                  key={m.id}
                  message={m}
                  audienceMode={audienceMode}
                  isModerator={isModerator}
                  onModerate={onModerate}
                />
              ))}
              {outbox.map((m) => (
                <li key={`out-${m.key}`} className="opacity-60">
                  <p className="text-[11px] text-ink-faint">
                    You ·{" "}
                    {m.failed ? (
                      <button
                        type="button"
                        onClick={() => onRetry(m.key)}
                        className="text-red-500 underline"
                      >
                        didn&apos;t send — try again
                      </button>
                    ) : (
                      "sending…"
                    )}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm text-ink">
                    {m.body}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {unseen > 0 && (
          <button
            type="button"
            onClick={toBottom}
            className="absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1 text-xs text-ink shadow-sm"
          >
            {unseen} new message{unseen === 1 ? "" : "s"}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {closed ? (
        <p className="border-t border-line p-3 text-center text-[11px] text-ink-faint">
          Chat is closed — the webinar has ended.
        </p>
      ) : (
        <ChatComposer onSend={onSend} />
      )}
    </div>
  );
}

function ChatRow({
  message,
  audienceMode,
  isModerator,
  onModerate,
}: {
  message: ChatMessage;
  audienceMode: AudienceMode;
  isModerator: boolean;
  onModerate: (
    id: string,
    action: "approve" | "remove" | "pin" | "unpin",
  ) => void;
}) {
  /**
   * A message the room cannot see yet.
   *
   * For a viewer this is only ever their OWN — the server never sends anyone
   * else's pending message — and it must keep showing, plainly labelled. A
   * student whose message vanished on send concludes the room is broken and
   * sends it again, which is how a moderated chat fills up with duplicates of
   * the thing the host was already about to approve.
   */
  const live = chatMessageIsLive(message, audienceMode);

  return (
    <li className={live ? "" : "rounded-lg bg-paper px-2 py-1.5"}>
      <p className="flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-ink-faint">
        <span className={message.isHost ? "text-phosphor-ink" : "text-ink-soft"}>
          {message.authorName}
        </span>
        {message.isHost && (
          <span className="rounded-full bg-phosphor/15 px-1.5 text-[10px] text-phosphor-ink">
            host
          </span>
        )}
        <LocalTime value={message.createdAt} mode="time" />
        {!live && <span className="italic">Waiting to be shown</span>}
      </p>
      <p className="whitespace-pre-wrap break-words text-sm text-ink">
        {message.body}
      </p>
      {isModerator && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {message.approvedAt === null && (
            <ChatAction
              label="Approve"
              onClick={() => onModerate(message.id, "approve")}
            >
              <Check className="h-3 w-3" />
            </ChatAction>
          )}
          <ChatAction
            label={message.pinned ? "Unpin" : "Pin"}
            onClick={() =>
              onModerate(message.id, message.pinned ? "unpin" : "pin")
            }
          >
            {message.pinned ? (
              <PinOff className="h-3 w-3" />
            ) : (
              <Pin className="h-3 w-3" />
            )}
          </ChatAction>
          <ChatAction
            label="Remove"
            onClick={() => onModerate(message.id, "remove")}
          >
            <Trash2 className="h-3 w-3" />
          </ChatAction>
        </div>
      )}
    </li>
  );
}

function ChatAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-faint hover:border-ink/30 hover:text-ink"
    >
      {children}
      {label}
    </button>
  );
}

function ChatComposer({ onSend }: { onSend: (body: string) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);

  // The same validator the server runs, so the button is never enabled for
  // input `sendChatMessage` would refuse.
  const valid = normalizeChatMessage(draft) !== null;

  function submit() {
    if (!valid || pending) return;
    const body = draft;
    // Cleared before the await, not after: the optimistic message is already
    // in the list, and a composer that holds the text until the round trip
    // finishes invites a second Enter and a duplicate message.
    setDraft("");
    startTransition(async () => {
      await onSend(body);
      ref.current?.focus();
    });
  }

  return (
    <div className="border-t border-line p-2">
      <Textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, MAX_CHAT_LENGTH))}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter for a newline, like every chat.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Say something…"
        rows={2}
        className="min-h-14 resize-none text-sm"
        aria-label="Chat message"
        disabled={pending}
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <p className="text-[11px] text-ink-faint">Enter sends</p>
        <Button size="sm" onClick={submit} disabled={!valid || pending}>
          Send
        </Button>
      </div>
    </div>
  );
}

/** Newest last, deduplicated by id. Both halves matter — see `apply`. */
function mergeChat(
  existing: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

function QuestionsTab({
  eventId,
  questions,
  isModerator,
  canUpvote,
  closed,
  myVotes,
  onVote,
  onAsked,
  onAction,
  onError,
}: {
  eventId: string;
  questions: RoomQuestion[];
  isModerator: boolean;
  /** Upvotes exist only where the audience can see each other's questions. */
  canUpvote: boolean;
  /** Ended: no new questions from the audience. */
  closed: boolean;
  myVotes: Set<string>;
  onVote: (id: string, on: boolean) => void;
  onAsked: (q: WebinarQuestion) => void;
  onAction: (fn: () => Promise<unknown>) => void;
  onError: (message: string) => void;
}) {
  /**
   * Most-wanted first.
   *
   * Votes descending, then oldest first inside a tie, which is what makes an
   * upvote mean anything: the host answers the question forty people had rather
   * than the one that happened to arrive last. The tie-break keeps an unvoted
   * queue reading top-to-bottom in the order people asked, exactly as the old
   * panel did — a room where nobody votes must not shuffle itself.
   */
  const sorted = useMemo(
    () =>
      [...questions].sort((a, b) => {
        const spotA = a.spotlighted ? 0 : 1;
        const spotB = b.spotlighted ? 0 : 1;
        if (spotA !== spotB) return spotA - spotB;
        const votes = (b.voteCount ?? 0) - (a.voteCount ?? 0);
        if (votes !== 0) return votes;
        return a.createdAt.localeCompare(b.createdAt);
      }),
    [questions],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!isModerator && !closed && (
        <AskComposer eventId={eventId} onAsked={onAsked} onError={onError} />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {sorted.length === 0 ? (
          <p className="py-6 text-center text-xs text-ink-faint">
            {isModerator
              ? "No questions yet."
              : "No questions yet — ask the first one."}
          </p>
        ) : (
          <ul className="space-y-2">
            {sorted.map((q) => (
              <li
                key={q.id}
                className={`rounded-lg border px-3 py-2 ${
                  q.spotlighted
                    ? "border-phosphor/50 bg-phosphor/10"
                    : q.status === "open"
                      ? "border-line bg-paper"
                      : "border-line/60 bg-wash opacity-60"
                }`}
              >
                <div className="flex items-start gap-2">
                  {canUpvote && (
                    <UpvoteButton
                      count={q.voteCount ?? 0}
                      on={myVotes.has(q.id)}
                      // Nobody upvotes their own question. `askerName` is "You"
                      // for the reader's own rows — the server resolves it that
                      // way precisely so a client never needs an id to compare.
                      mine={q.askerName === "You"}
                      onToggle={(on) => onVote(q.id, on)}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] text-ink-faint">
                      <span className="text-ink-soft">{q.askerName}</span>
                      <LocalTime value={q.createdAt} mode="time" />
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink">
                      {q.body}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <QuestionStatusBadge status={q.status} />
                      {isModerator ? (
                        <>
                          <ChatAction
                            label={q.spotlighted ? "Unspotlight" : "Spotlight"}
                            onClick={() =>
                              onAction(() =>
                                spotlightQuestion(eventId, q.id, !q.spotlighted),
                              )
                            }
                          >
                            <Sparkles className="h-3 w-3" />
                          </ChatAction>
                          {!q.approvedAt && (
                            <ChatAction
                              label="Approve"
                              onClick={() =>
                                onAction(() => approveQuestion(eventId, q.id))
                              }
                            >
                              <Check className="h-3 w-3" />
                            </ChatAction>
                          )}
                          <ChatAction
                            label="Answered"
                            onClick={() =>
                              onAction(() =>
                                setQuestionStatus(eventId, q.id, "answered"),
                              )
                            }
                          >
                            <Check className="h-3 w-3" />
                          </ChatAction>
                          <ChatAction
                            label="Dismiss"
                            onClick={() =>
                              onAction(() =>
                                setQuestionStatus(eventId, q.id, "dismissed"),
                              )
                            }
                          >
                            <X className="h-3 w-3" />
                          </ChatAction>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function UpvoteButton({
  count,
  on,
  mine,
  onToggle,
}: {
  count: number;
  on: boolean;
  mine: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      disabled={mine}
      onClick={() => onToggle(!on)}
      aria-pressed={on}
      aria-label={mine ? "You asked this" : on ? "Remove upvote" : "Upvote"}
      title={mine ? "You can't upvote your own question" : undefined}
      className={`flex w-10 shrink-0 flex-col items-center rounded-lg border px-1 py-1 text-[11px] tabular-nums transition disabled:cursor-not-allowed disabled:opacity-50 ${
        on
          ? "border-phosphor/50 bg-phosphor/15 text-phosphor-ink"
          : "border-line text-ink-faint hover:border-ink/30 hover:text-ink"
      }`}
    >
      <ArrowBigUp className="h-4 w-4" />
      {count}
    </button>
  );
}

function AskComposer({
  eventId,
  onAsked,
  onError,
}: {
  eventId: string;
  onAsked: (q: WebinarQuestion) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);

  const valid = normalizeQuestion(draft) !== null;

  function submit() {
    if (!valid || pending) return;
    const raw = draft;
    startTransition(async () => {
      try {
        const created = await askQuestion(eventId, raw);
        onAsked(created);
        setDraft("");
        ref.current?.focus();
      } catch (e: any) {
        onError(getActionError(e));
      }
    });
  }

  return (
    <div className="border-b border-line p-3">
      <Textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, MAX_QUESTION_LENGTH))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Ask the host a question…"
        rows={2}
        className="min-h-14 resize-none text-sm"
        aria-label="Your question"
        disabled={pending}
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <p className="text-[11px] text-ink-faint">A host reads these live.</p>
        <Button size="sm" onClick={submit} disabled={!valid || pending}>
          {pending ? "Sending…" : "Ask"}
        </Button>
      </div>
    </div>
  );
}

/** The badge from qa-panel.tsx, unchanged, so one queue can't look like two. */
function QuestionStatusBadge({ status }: { status: QuestionStatus }) {
  const label =
    status === "answered"
      ? "Answered"
      : status === "dismissed"
        ? "Dismissed"
        : "Sent";
  const tone =
    status === "answered"
      ? "bg-phosphor/15 text-phosphor-ink"
      : status === "dismissed"
        ? "bg-ink/10 text-ink-faint"
        : "bg-ink/5 text-ink-soft";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

function PollsTab({
  eventId,
  polls,
  isModerator,
  closed,
  onVote,
  onSetOpen,
  onCreated,
  onError,
}: {
  eventId: string;
  polls: WebinarPoll[];
  isModerator: boolean;
  /** Ended: votes are frozen for the audience. */
  closed: boolean;
  onVote: (pollId: string, choice: number) => void;
  onSetOpen: (pollId: string, open: boolean) => void;
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {isModerator && (
        <CreatePollForm
          eventId={eventId}
          onCreated={onCreated}
          onError={onError}
        />
      )}

      {polls.length === 0 ? (
        <p className="py-6 text-center text-xs text-ink-faint">
          {isModerator
            ? "No polls yet. Draft one above — it stays hidden until you open it."
            : "No polls right now."}
        </p>
      ) : (
        <ul className="space-y-3">
          {polls.map((p) => (
            <PollCard
              key={p.id}
              poll={p}
              isModerator={isModerator}
              closed={closed}
              onVote={onVote}
              onSetOpen={onSetOpen}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PollCard({
  poll,
  isModerator,
  closed,
  onVote,
  onSetOpen,
}: {
  poll: WebinarPoll;
  isModerator: boolean;
  closed: boolean;
  onVote: (pollId: string, choice: number) => void;
  onSetOpen: (pollId: string, open: boolean) => void;
}) {
  // A moderator always sees the numbers; the audience sees them when the host
  // chose to share them. The server has already zeroed a hidden tally on its
  // way out, so this decides layout, not disclosure.
  const showResults = isModerator || poll.resultsVisible;
  const percentages = pollPercentages(poll.tally);
  const total = poll.tally.reduce((a, b) => a + b, 0);

  return (
    <li className="rounded-lg border border-line bg-paper p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-ink">{poll.question}</p>
        {!poll.open && (
          <span className="shrink-0 rounded-full bg-ink/10 px-2 py-0.5 text-[10px] text-ink-faint">
            {isModerator ? "draft" : "closed"}
          </span>
        )}
      </div>

      <ul className="mt-2 space-y-1.5">
        {poll.options.map((option, i) => {
          const mine = poll.myChoice === i;
          return (
            <li key={i}>
              <button
                type="button"
                // A vote is changeable while the poll is open — a student who
                // misread the options should not be stuck with the wrong answer
                // in front of the room — and frozen the moment it closes.
                disabled={!poll.open || closed}
                onClick={() => onVote(poll.id, i)}
                aria-pressed={mine}
                className={`relative w-full overflow-hidden rounded-md border px-2.5 py-1.5 text-left text-xs transition disabled:cursor-default ${
                  mine
                    ? "border-phosphor/50 text-phosphor-ink"
                    : "border-line text-ink hover:border-ink/30"
                }`}
              >
                {showResults && (
                  <span
                    className="absolute inset-y-0 left-0 bg-phosphor/15"
                    style={{ width: `${percentages[i] ?? 0}%` }}
                    aria-hidden
                  />
                )}
                <span className="relative flex items-center justify-between gap-2">
                  <span className="min-w-0 break-words">{option}</span>
                  {showResults && (
                    <span className="shrink-0 tabular-nums text-ink-faint">
                      {percentages[i] ?? 0}%
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-ink-faint">
          {showResults
            ? `${total} vote${total === 1 ? "" : "s"}`
            : "Results are hidden"}
        </p>
        {isModerator && (
          <Button
            size="sm"
            variant={poll.open ? "secondary" : "primary"}
            onClick={() => onSetOpen(poll.id, !poll.open)}
          >
            {poll.open ? "Close" : "Open"}
          </Button>
        )}
      </div>
    </li>
  );
}

function CreatePollForm({
  eventId,
  onCreated,
  onError,
}: {
  eventId: string;
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [resultsVisible, setResultsVisible] = useState(true);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // The exact validator the action runs, so the button is never enabled for
  // input `createPoll` would throw on — and the reason it can be read as you
  // type at all is that normalizePoll returns the message instead of throwing.
  const checked = normalizePoll({ question, options });
  const touched = question.trim() !== "" || options.some((o) => o.trim() !== "");

  function submit() {
    if (!checked.ok || pending) return;
    startTransition(async () => {
      try {
        await createPoll(eventId, {
          question: checked.question,
          options: checked.options,
          resultsVisible,
        });
        setQuestion("");
        setOptions(["", ""]);
        setOpen(false);
        onCreated();
      } catch (e: any) {
        onError(getActionError(e));
      }
    });
  }

  if (!open) {
    return (
      <div className="mb-3">
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          New poll
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg border border-line bg-paper p-3">
      <Input
        value={question}
        onChange={(e) =>
          setQuestion(e.target.value.slice(0, MAX_POLL_QUESTION_LENGTH))
        }
        placeholder="Poll question"
        aria-label="Poll question"
        className="text-sm"
      />
      <ul className="mt-2 space-y-1.5">
        {options.map((option, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <Input
              value={option}
              onChange={(e) =>
                setOptions((prev) =>
                  prev.map((o, j) =>
                    j === i ? e.target.value.slice(0, MAX_POLL_OPTION_LENGTH) : o,
                  ),
                )
              }
              placeholder={`Option ${i + 1}`}
              aria-label={`Option ${i + 1}`}
              className="text-sm"
            />
            {options.length > 2 && (
              <button
                type="button"
                onClick={() =>
                  setOptions((prev) => prev.filter((_, j) => j !== i))
                }
                aria-label={`Remove option ${i + 1}`}
                className="shrink-0 text-ink-faint hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>

      {options.length < MAX_POLL_OPTIONS && (
        <button
          type="button"
          onClick={() => setOptions((prev) => [...prev, ""])}
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink"
        >
          <Plus className="h-3 w-3" />
          Add option
        </button>
      )}

      <label className="mt-2 flex items-center gap-2 text-xs text-ink-soft">
        <input
          type="checkbox"
          checked={resultsVisible}
          onChange={(e) => setResultsVisible(e.target.checked)}
          className="h-3.5 w-3.5 accent-phosphor"
        />
        Show results to everyone
      </label>

      {touched && !checked.ok && (
        <p className="mt-2 text-[11px] text-red-500">{checked.error}</p>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={!checked.ok || pending}>
          {pending ? "Saving…" : "Save draft"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-ink-faint">
        Saved closed — nobody sees it until you press Open.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

function ReactionBar({ onReact }: { onReact: (emoji: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-line px-2 py-1.5">
      {REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onReact(emoji)}
          aria-label={`React ${emoji}`}
          className="rounded-md px-1.5 py-0.5 text-base leading-none transition hover:bg-phosphor/10 active:scale-95"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

/**
 * The float, as a style element rather than a Tailwind utility.
 *
 * The keyframes belong to this component and nothing else uses them, so they
 * ship with it instead of growing app/globals.css — which this panel has no
 * business editing. Removal is driven by a JS timer, never by `animationend`:
 * the global reduced-motion rule collapses every animation to 0.001ms, so an
 * emoji that waited for the animation to finish would vanish instantly for
 * exactly the people who asked for less motion, and one that waited for an
 * event that never fired would never leave at all.
 */
function ReactionStyles() {
  return (
    <style>{`
      @keyframes b0-react-float {
        0%   { transform: translateY(0) scale(0.8); opacity: 0; }
        15%  { transform: translateY(-12px) scale(1); opacity: 1; }
        100% { transform: translateY(-220px) scale(1.1); opacity: 0; }
      }
      .b0-react {
        animation: b0-react-float 2s ease-out forwards;
        will-change: transform, opacity;
      }
    `}</style>
  );
}
