"use server";
import { requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { notifyModerators, notifyRoom } from "@/lib/live-rooms";
import { canJoin, joinState, type WebinarQuestion } from "@/lib/live";
import {
  audienceCanSeeEachOther,
  isHostedOnBatch0,
  messagesNeedApproval,
  normalizeAudienceMode,
  normalizeChatMessage,
  normalizePoll,
  premiereState,
  CHAT_BURST_LIMIT,
  type AudienceMode,
  type ChatMessage,
  type WebinarPoll,
} from "@/lib/webinars";
import {
  listChat,
  listPolls,
  pinnedMessage,
  speakerUserIds,
} from "@/lib/webinar-data";
import {
  listQuestionsForAsker,
  listQuestionsForEvent,
} from "@/lib/webinar-questions";

/**
 * Server actions for everything in a webinar that isn't video.
 *
 * Chat, the question queue, polls, and the premiere handover. Split out of
 * ./actions.ts (which keeps the original Q&A trio) rather than appended to it,
 * because these are called on a completely different cadence: the Q&A actions
 * were written for a 5-second poll, and these answer a Realtime bump within
 * 250ms of something actually happening. Keeping them apart means the older
 * file's comments stay true of the code in it.
 *
 * ---------------------------------------------------------------------------
 * Why every one of these re-runs the gate
 * ---------------------------------------------------------------------------
 *
 * The same reason ./actions.ts gives, and it has not got any less true: a
 * server action is its own entry point, callable by anyone who can guess its
 * id, so the page having rendered proves nothing about who is calling. Every
 * action here starts with `gateRoom`, which reads the event through the
 * CALLER'S OWN RLS — so eligibility to chat is exactly eligibility to see the
 * event, with no second rule to keep in step with the `events read` policy.
 *
 * ---------------------------------------------------------------------------
 * Where the privacy actually lives
 * ---------------------------------------------------------------------------
 *
 * In `gateRoom`, and nowhere else in this file. It returns `audienceMode` and
 * `isModerator`, and every read below shapes its result from those two values
 * rather than working anything out for itself. The rule it encodes:
 *
 *   private    A viewer reads their own questions and nothing else. No chat,
 *              no polls-with-names, no upvotes, no evidence that anyone else
 *              is in the room. This is the pre-0084 behaviour, unchanged, and
 *              it is the default.
 *   moderated  A viewer reads approved messages and their own pending ones.
 *   open       A viewer reads everything the room has said.
 *
 * A moderator — staff with `events.manage`, or a guest speaker on this event —
 * always reads everything, because that IS the moderation queue.
 */

type RoomGate = {
  eventId: string;
  startsAt: string;
  endsAt: string | null;
  liveMode: string;
  audienceMode: AudienceMode;
  premiereSeconds: number | null;
  qaOpensAt: string | null;
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  userId: string;
  /** Staff with `events.manage`, or a guest speaker on THIS event. */
  isModerator: boolean;
  /** Staff only. A guest speaker may moderate without being able to schedule. */
  isStaff: boolean;
};

/**
 * Read the event through the caller's own RLS and work out what they are.
 *
 * Returns null for "you can't see this event", "this isn't a batch0-hosted
 * event", and "the room isn't open" — one answer for all three, so this cannot
 * be used to probe which events exist, exactly as `joinRoom` does not.
 */
async function gateRoom(eventId: string): Promise<RoomGate | null> {
  const actor = await requireActor();
  const supabase = await createClient();
  const { data } = await supabase
    .from("events")
    .select(
      "id, starts_at, ends_at, live_mode, audience_mode, premiere_seconds, qa_opens_at, live_started_at, live_ended_at",
    )
    .eq("id", eventId)
    .maybeSingle();
  const ev = data as any;
  if (!ev || !isHostedOnBatch0(ev.live_mode)) return null;
  if (!canJoin(joinState(ev.starts_at, ev.ends_at))) return null;

  const isStaff = can(actor.caps, "events.manage");
  const isModerator =
    isStaff || (await speakerUserIds(ev.id)).includes(actor.userId);

  return {
    eventId: ev.id,
    startsAt: ev.starts_at,
    endsAt: ev.ends_at ?? null,
    liveMode: ev.live_mode,
    audienceMode: normalizeAudienceMode(ev.audience_mode),
    premiereSeconds: ev.premiere_seconds ?? null,
    qaOpensAt: ev.qa_opens_at ?? null,
    liveStartedAt: ev.live_started_at ?? null,
    liveEndedAt: ev.live_ended_at ?? null,
    userId: actor.userId,
    isModerator,
    isStaff,
  };
}

// ---------------------------------------------------------------------------
// The room's whole text state, in one call
// ---------------------------------------------------------------------------

export type RoomState = {
  audienceMode: AudienceMode;
  isModerator: boolean;
  chat: ChatMessage[];
  pinned: ChatMessage | null;
  questions: WebinarQuestion[];
  polls: WebinarPoll[];
  /** Newest chat timestamp in this payload — pass back as `chatSince`. */
  cursor: string | null;
  /** Set once a host has gone live. Drives the premiere handover. */
  liveStartedAt: string | null;
  /**
   * Set once a host has pressed End.
   *
   * This is what lets a viewer be TOLD the webinar is over instead of being
   * left on "waiting for the host to start" until the join window closes half
   * an hour later. It has to come from the server: the stage channel's
   * `host-offline` message is deliberately ignored by every client, because a
   * viewer holds no proof to verify it with and acting on an unauthenticated
   * "the host left" would let any student end the webinar for the whole room.
   * A column the server stamps is the same signal with an author.
   */
  liveEndedAt: string | null;
};

/**
 * Everything the panels need, answered together.
 *
 * One action rather than four, because a bump means "something changed" and
 * almost every change is worth re-reading more than one panel — a host
 * approving a message changes the chat AND clears the moderation badge, and a
 * question being spotlighted changes the queue AND what the room shows. Four
 * actions would be four round trips per bump per client, which at fifty
 * viewers is precisely the pile-up the old polling design was written to
 * avoid.
 *
 * `chatSince` makes the common case cheap: a bump re-reads only the messages
 * after the cursor the client already holds. Questions and polls are re-read in
 * full because they are small and mutable — a question's vote count and status
 * change in place, so "what's new" is not a question a timestamp can answer.
 */
export async function fetchRoomState(
  eventId: string,
  chatSince?: string | null,
): Promise<RoomState | null> {
  const gate = await gateRoom(eventId);
  if (!gate) return null;

  const chatty = audienceCanSeeEachOther(gate.audienceMode);
  const canReadChat = gate.isModerator || chatty;

  const [chat, pinned, questions, polls] = await Promise.all([
    canReadChat
      ? listChat({
          eventId,
          readerId: gate.userId,
          forModerator: gate.isModerator,
          since: chatSince ?? null,
        })
      : Promise.resolve([] as ChatMessage[]),
    canReadChat
      ? pinnedMessage(eventId, gate.userId)
      : Promise.resolve(null),
    // The question split is the pre-0084 rule, widened by exactly one case: in
    // a room where the audience can see itself, a viewer sees the approved
    // queue too, which is what makes upvoting mean anything. In `private` it is
    // untouched — their own questions and nothing else.
    gate.isModerator
      ? listQuestionsForEvent(eventId)
      : chatty
        ? listVisibleQuestions(eventId, gate.userId)
        : listQuestionsForAsker(eventId, gate.userId),
    listPolls({
      eventId,
      readerId: gate.userId,
      forModerator: gate.isModerator,
    }),
  ]);

  return {
    audienceMode: gate.audienceMode,
    isModerator: gate.isModerator,
    chat,
    pinned,
    questions,
    // A poll whose results the host has chosen to keep back is returned with
    // its tally zeroed rather than omitted: the audience must still see the
    // question and be able to vote. Done here, where the role is known, rather
    // than in listPolls, which a host also calls.
    polls: gate.isModerator
      ? polls
      : polls.map((p) =>
          p.resultsVisible ? p : { ...p, tally: p.tally.map(() => 0) },
        ),
    cursor: chat.length > 0 ? chat[chat.length - 1].createdAt : chatSince ?? null,
    liveStartedAt: gate.liveStartedAt,
    liveEndedAt: gate.liveEndedAt,
  };
}

/**
 * Questions a viewer may see in a `moderated` / `open` room.
 *
 * Their own, plus everyone's approved ones. Service-role with explicit filters,
 * the same contract lib/webinar-questions.ts states — and the reason it lives
 * here rather than there is that this is the first read in the system that
 * returns one student's words to another, which is a decision that belongs next
 * to the gate that authorised it.
 */
async function listVisibleQuestions(
  eventId: string,
  readerId: string,
): Promise<WebinarQuestion[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("webinar_questions")
    .select(
      "id, event_id, asker_id, body, status, vote_count, spotlighted, approved_at, created_at, " +
        "asker:profiles!webinar_questions_asker_id_fkey(full_name)",
    )
    .eq("event_id", eventId)
    .or(`approved_at.not.is.null,asker_id.eq.${readerId}`)
    .neq("status", "dismissed")
    .order("created_at", { ascending: true })
    .limit(300);
  return (data ?? []).map((row: any) => {
    const asker = Array.isArray(row.asker) ? row.asker[0] : row.asker;
    return {
      id: row.id,
      eventId: row.event_id,
      askerId: row.asker_id,
      askerName:
        row.asker_id === readerId ? "You" : asker?.full_name || "A student",
      body: row.body,
      status: row.status,
      createdAt: row.created_at,
    };
  });
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * Say something in the room.
 *
 * The rate limit is deliberately belt-and-braces. The RLS insert policy (0084)
 * is the guard that actually binds — the anon-key browser client carries the
 * student's JWT and could write to `webinar_messages` directly, skipping this
 * action entirely — and `checkRateLimit` here is what turns a refusal into a
 * sentence a person can read instead of a Postgres policy violation. Keep
 * CHAT_BURST_LIMIT in step with the `< 5` in that policy.
 *
 * Note `checkRateLimit` fails OPEN on database trouble, which is the right call
 * for the same reason lib/founder-pass.ts gives: a transient Supabase problem
 * should not silence a room, and the RLS copy is still standing behind it.
 */
export async function sendChatMessage(
  eventId: string,
  raw: string,
): Promise<ChatMessage> {
  const gate = await gateRoom(eventId);
  if (!gate) throw new Error("You can't post to this event.");
  if (!audienceCanSeeEachOther(gate.audienceMode)) {
    throw new Error("Chat is off for this webinar — ask a question instead.");
  }

  const body = normalizeChatMessage(raw);
  if (!body) throw new Error("Write something first.");

  const limited = await checkRateLimit({
    kind: "webinar-chat",
    identifier: `${eventId}:${gate.userId}`,
    limit: CHAT_BURST_LIMIT,
    windowSeconds: 10,
  });
  if (!limited.ok) throw new Error("Slow down a moment.");

  // A moderator's own message is live immediately. There is nothing for a host
  // to approve about a host, and a room where the person running it has to
  // approve themselves before anyone can read their answer is a room that
  // stops working the moment it gets busy.
  const approvedNow = gate.isModerator || !messagesNeedApproval(gate.audienceMode);

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("webinar_messages")
    .insert({
      event_id: eventId,
      author_id: gate.userId,
      body,
      // Snapshotted, not derived at read time: a host who later loses the
      // permission should not retroactively become a student in the transcript.
      is_host: gate.isModerator,
      approved_at: approvedNow ? new Date().toISOString() : null,
    })
    .select(
      "id, event_id, author_id, body, is_host, approved_at, pinned, created_at",
    )
    .single();
  if (error) throw new Error(error.message);
  const row = data as any;

  // Tell the room, or tell the hosts. Which one is the whole of `moderated`
  // mode: a pending message is announced on a channel no viewer holds, so it
  // is not merely undrawn in the audience's browser, it never arrives there.
  if (approvedNow) {
    await notifyRoom(`event:${eventId}`, {
      t: "bump",
      what: "chat",
      cursor: row.created_at,
    });
  } else {
    await notifyModerators(`event:${eventId}`, { t: "bump", what: "chat" });
  }

  return {
    id: row.id,
    eventId: row.event_id,
    authorId: row.author_id,
    authorName: "You",
    body: row.body,
    isHost: !!row.is_host,
    approvedAt: row.approved_at ?? null,
    pinned: !!row.pinned,
    createdAt: row.created_at,
  };
}

export type ChatModeration = "approve" | "remove" | "pin" | "unpin";

/** Approve, hide, or pin a message. Moderators only. */
export async function moderateChatMessage(
  eventId: string,
  messageId: string,
  action: ChatModeration,
): Promise<void> {
  const gate = await gateRoom(eventId);
  if (!gate?.isModerator) throw new Error("Forbidden");
  const admin = createAdminClient();
  const now = new Date().toISOString();

  if (action === "pin") {
    // Two writes, and the order matters. Unpinning first means the worst
    // interleaving leaves NO pin (a blank strip, which reads as "nothing is
    // pinned") rather than two (a strip that renders one of them arbitrarily
    // and disagrees between clients).
    await admin
      .from("webinar_messages")
      .update({ pinned: false })
      .eq("event_id", eventId)
      .eq("pinned", true);
  }

  const patch =
    action === "approve"
      ? { approved_at: now, removed_at: null }
      : action === "remove"
        ? { removed_at: now, pinned: false }
        : { pinned: action === "pin" };

  const { error } = await admin
    .from("webinar_messages")
    .update(patch)
    .eq("id", messageId)
    // Scoped to the event the caller was gated on, so a moderator of one
    // webinar cannot moderate another's message by id.
    .eq("event_id", eventId);
  if (error) throw new Error(error.message);

  await notifyRoom(`event:${eventId}`, { t: "bump", what: "chat" });
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * Upvote, or take it back.
 *
 * The point is to let a host answer the question forty people had rather than
 * the one that happened to arrive last, so it only exists where the audience
 * can see each other's questions at all. In `private` mode there is nothing to
 * vote on and this refuses.
 *
 * An upvote is a row, not a counter: a counter cannot be un-voted, cannot be
 * deduplicated, and cannot survive two people voting in the same millisecond.
 * The denormalised `vote_count` the host sorts by is maintained by the trigger
 * in 0084, so it is recounted rather than stepped and cannot drift.
 */
export async function voteOnQuestion(
  eventId: string,
  questionId: string,
  on: boolean,
): Promise<void> {
  const gate = await gateRoom(eventId);
  if (!gate) throw new Error("You can't vote here.");
  if (!audienceCanSeeEachOther(gate.audienceMode)) {
    throw new Error("Upvotes are off for this webinar.");
  }
  const admin = createAdminClient();
  if (on) {
    // Idempotent: a double-click, a retried request, and two tabs all converge
    // on the one row the primary key allows.
    const { error } = await admin
      .from("webinar_question_votes")
      .upsert(
        { question_id: questionId, voter_id: gate.userId },
        { onConflict: "question_id,voter_id", ignoreDuplicates: true },
      );
    if (error) throw new Error(error.message);
  } else {
    const { error } = await admin
      .from("webinar_question_votes")
      .delete()
      .eq("question_id", questionId)
      .eq("voter_id", gate.userId);
    if (error) throw new Error(error.message);
  }
  await notifyRoom(`event:${eventId}`, { t: "bump", what: "qa" });
}

/**
 * Put a question on the room's screen, or take it down.
 *
 * Clears any other spotlight first, for the same reason `pin` does: one
 * question at a time is the point, and the failure mode of the other order is
 * two spotlights that different clients resolve differently.
 */
export async function spotlightQuestion(
  eventId: string,
  questionId: string,
  on: boolean,
): Promise<void> {
  const gate = await gateRoom(eventId);
  if (!gate?.isModerator) throw new Error("Forbidden");
  const admin = createAdminClient();
  await admin
    .from("webinar_questions")
    .update({ spotlighted: false })
    .eq("event_id", eventId)
    .eq("spotlighted", true);
  if (on) {
    const { error } = await admin
      .from("webinar_questions")
      // Spotlighting also approves. A host who puts a question on the room's
      // screen has plainly decided the room may see it, and making them press
      // two buttons for one decision is how a queue gets a question that is
      // visibly featured and technically hidden.
      .update({ spotlighted: true, approved_at: new Date().toISOString() })
      .eq("id", questionId)
      .eq("event_id", eventId);
    if (error) throw new Error(error.message);
  }
  await notifyRoom(`event:${eventId}`, { t: "bump", what: "qa" });
}

/** Let a queued question through to the room. Moderators only. */
export async function approveQuestion(
  eventId: string,
  questionId: string,
): Promise<void> {
  const gate = await gateRoom(eventId);
  if (!gate?.isModerator) throw new Error("Forbidden");
  const admin = createAdminClient();
  const { error } = await admin
    .from("webinar_questions")
    .update({ approved_at: new Date().toISOString() })
    .eq("id", questionId)
    .eq("event_id", eventId);
  if (error) throw new Error(error.message);
  await notifyRoom(`event:${eventId}`, { t: "bump", what: "qa" });
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

export async function createPoll(
  eventId: string,
  input: { question: string; options: string[]; resultsVisible: boolean },
): Promise<string> {
  const gate = await gateRoom(eventId);
  if (!gate?.isModerator) throw new Error("Forbidden");
  // Same validator the form runs as you type, so the button is never enabled
  // for input this would refuse.
  const cleaned = normalizePoll(input);
  if (!cleaned.ok) throw new Error(cleaned.error);

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("webinar_polls")
    .insert({
      event_id: eventId,
      question: cleaned.question,
      options: cleaned.options,
      results_visible: input.resultsVisible,
      created_by: gate.userId,
      // Drafted closed. A poll appears when the host wants it to, which is what
      // lets them write a webinar's polls in advance without giving away where
      // the talk is going.
      open: false,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as any).id;
}

export async function setPollOpen(
  eventId: string,
  pollId: string,
  open: boolean,
): Promise<void> {
  const gate = await gateRoom(eventId);
  if (!gate?.isModerator) throw new Error("Forbidden");
  const admin = createAdminClient();
  const { error } = await admin
    .from("webinar_polls")
    .update({ open })
    .eq("id", pollId)
    .eq("event_id", eventId);
  if (error) throw new Error(error.message);
  await notifyRoom(`event:${eventId}`, { t: "bump", what: "poll" });
}

export async function voteOnPoll(
  eventId: string,
  pollId: string,
  choice: number,
): Promise<void> {
  const gate = await gateRoom(eventId);
  if (!gate) throw new Error("You can't vote here.");
  const admin = createAdminClient();

  // Bound the choice against this poll's own options before writing. The RLS
  // policy does this too (`choice < jsonb_array_length(p.options)`) and that is
  // the copy that binds; this one is what turns "option 97" into a refusal
  // rather than a policy violation, and it is also what stops a vote being
  // recorded against a poll the host has since closed.
  const { data: poll } = await admin
    .from("webinar_polls")
    .select("id, options, open")
    .eq("id", pollId)
    .eq("event_id", eventId)
    .maybeSingle();
  const options = (poll as any)?.options;
  if (!poll || !(poll as any).open) throw new Error("That poll is closed.");
  if (!Array.isArray(options) || choice < 0 || choice >= options.length) {
    throw new Error("That isn't one of the options.");
  }

  const { error } = await admin
    .from("webinar_poll_votes")
    .upsert(
      { poll_id: pollId, voter_id: gate.userId, choice },
      { onConflict: "poll_id,voter_id" },
    );
  if (error) throw new Error(error.message);
  await notifyRoom(`event:${eventId}`, { t: "bump", what: "poll" });
}

// ---------------------------------------------------------------------------
// The premiere handover
// ---------------------------------------------------------------------------

/**
 * Go live — either because the recording has finished, or early.
 *
 * Stamping `live_started_at` is what makes the switch authoritative rather than
 * a race between twelve browsers' clocks. `premiereState` gives the stamp
 * absolute precedence over the schedule for exactly this reason: a host who
 * presses this thirty minutes into a forty-minute recording has made a decision
 * about the room, and the alternative is an audience watching a recording of
 * someone who is live on the other side of the same page.
 *
 * The bump is a hint and nothing more. Every client also computes the handover
 * from the clock and re-reads `live_started_at` before switching, so a viewer
 * whose channel dropped the message still switches — a few seconds later, on
 * their own resync.
 *
 * Idempotent: a second press, or a reload that re-fires it, keeps the FIRST
 * timestamp. Re-stamping would move the handover forward under an audience that
 * had already been switched.
 */
export async function goLive(eventId: string): Promise<string | null> {
  const gate = await gateRoom(eventId);
  if (!gate?.isModerator) throw new Error("Forbidden");
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("events")
    .update({ live_started_at: now })
    .eq("id", eventId)
    .is("live_started_at", null)
    .select("live_started_at")
    .maybeSingle();
  if (error) throw new Error(error.message);

  // Null data means the row was already stamped — the update matched nothing.
  // Read back what is actually there, so the caller gets the real handover
  // moment rather than a timestamp that was never stored.
  const settled = (data as any)?.live_started_at ?? (await readLiveStartedAt(eventId));
  await notifyRoom(`event:${eventId}`, { t: "stage-change" });
  return settled;
}

/**
 * End the webinar for everyone.
 *
 * What the host's End button actually does, and the reason it is a server
 * action rather than a local teardown. Closing the host's tab already tears the
 * peer connections down — `bye` on `pagehide` sees to that — but it leaves
 * every viewer looking at "waiting for the host to start", because from the
 * browser's point of view a host who has ended and a host who has dropped off
 * hotel wifi are the same event. The audience then sits there until the join
 * window closes half an hour later.
 *
 * Stamping the row is what distinguishes the two. `fetchRoomState` returns it,
 * every client polls it as a backstop to the bump, and the room can honestly
 * say the webinar is over.
 *
 * Reopening is deliberately possible: a host who ends by accident, or who has
 * to come back for one more question, presses Start again and `live_ended_at`
 * is cleared. The alternative — a one-way door — turns a misclick into a
 * webinar nobody can rejoin.
 */
export async function endLive(eventId: string): Promise<void> {
  const gate = await gateRoom(eventId);
  if (!gate?.isModerator) throw new Error("Forbidden");
  const admin = createAdminClient();
  const { error } = await admin
    .from("events")
    .update({ live_ended_at: new Date().toISOString() })
    .eq("id", eventId);
  if (error) throw new Error(error.message);
  await notifyRoom(`event:${eventId}`, { t: "stage-change" });
}

/** Undo an End — the host came back. */
export async function reopenLive(eventId: string): Promise<void> {
  const gate = await gateRoom(eventId);
  if (!gate?.isModerator) throw new Error("Forbidden");
  const admin = createAdminClient();
  const { error } = await admin
    .from("events")
    .update({ live_ended_at: null })
    .eq("id", eventId);
  if (error) throw new Error(error.message);
  await notifyRoom(`event:${eventId}`, { t: "stage-change" });
}

async function readLiveStartedAt(eventId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("events")
    .select("live_started_at")
    .eq("id", eventId)
    .maybeSingle();
  return (data as any)?.live_started_at ?? null;
}

/**
 * Where the premiere is, according to the server's clock.
 *
 * The seek offset MUST come from here and not from the browser. A viewer whose
 * laptop clock is four minutes fast would otherwise sit four minutes ahead of
 * everyone else — visibly, in chat, reacting to something nobody has seen yet —
 * and a viewer whose clock is wrong by an hour would see a black screen and
 * conclude the webinar never started.
 *
 * Polled as a backstop to the `stage-change` bump, and re-read before any
 * client acts on one.
 */
export async function fetchPremiereState(eventId: string) {
  const gate = await gateRoom(eventId);
  if (!gate) return null;
  return {
    ...premiereState({
      startsAt: gate.startsAt,
      premiereSeconds: gate.premiereSeconds,
      qaOpensAt: gate.qaOpensAt,
      liveStartedAt: gate.liveStartedAt,
      endsAt: gate.endsAt,
    }),
    liveStartedAt: gate.liveStartedAt,
    liveEndedAt: gate.liveEndedAt,
    // Sent so the client can measure its own clock against the server's and
    // say so in the console when they disagree — a four-minute skew is
    // otherwise invisible and presents as "the video is out of sync for one
    // student", which is unreproducible by anyone else.
    serverNow: new Date().toISOString(),
  };
}
