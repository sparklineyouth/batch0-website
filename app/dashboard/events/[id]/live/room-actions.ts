"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import {
  closeOpenAttendance,
  notifyModerators,
  notifyRoom,
  notifyStage,
} from "@/lib/live-rooms";
import {
  roomIsOpen,
  type QuestionStatus,
  type RoomAccess,
  type WebinarQuestion,
} from "@/lib/live";
import {
  audienceCanSeeEachOther,
  canEndForEveryone,
  isHostedOnBatch0,
  isPremiere,
  messagesNeedApproval,
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
} from "@/lib/webinar-data";
import {
  listQuestionsForAsker,
  listQuestionsForEvent,
} from "@/lib/webinar-questions";
import {
  presentHostRoles,
  resolveEventAccess,
  roomAccessFor,
  withinHardClose,
} from "@/lib/live-access";

/**
 * Server actions for everything in a webinar that isn't video.
 *
 * Chat, the question queue, polls, the premiere handover, and End / Reopen.
 * Split out of ./actions.ts (which keeps the original Q&A trio) rather than
 * appended to it, because these are called on a completely different cadence:
 * the Q&A actions were written for a 5-second poll, and these answer a
 * Realtime bump within 250ms of something actually happening. Keeping them
 * apart means the older file's comments stay true of the code in it.
 *
 * ---------------------------------------------------------------------------
 * Why every one of these re-runs the gate
 * ---------------------------------------------------------------------------
 *
 * The same reason ./actions.ts gives, and it has not got any less true: a
 * server action is its own entry point, callable by anyone who can guess its
 * id, so the page having rendered proves nothing about who is calling. Every
 * action here starts with `gateRoom` or `gateVisible`, both built on
 * `resolveEventAccess` (lib/live-access.ts) — the same resolution the page and
 * joinRoom use, so eligibility to chat is exactly eligibility to be in the
 * room, and "who is a host" has one answer across the whole subsystem.
 *
 * ---------------------------------------------------------------------------
 * Where the privacy actually lives
 * ---------------------------------------------------------------------------
 *
 * In the gate, and nowhere else in this file. It returns `audienceMode` and
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
  /** A claimed guest speaker (never also staff). */
  isSpeaker: boolean;
  /** The caller's roomAccess right now (host window for moderators). */
  access: RoomAccess;
};

/**
 * Role and visibility, NO window.
 *
 * Used by the teardown-shaped actions — End and Reopen — which must work
 * whenever the room could plausibly still be running: an overrunning webinar
 * that loses its End button at end+30m is how a webinar used to never get
 * ended at all. They bound themselves by the hard stop instead.
 *
 * Returns null for "you can't see this event" and "this isn't a batch0-hosted
 * event" — one answer for both, so this cannot be used to probe which events
 * exist, exactly as `joinRoom` does not.
 *
 * `throwOnError` makes a failed read THROW instead of answering null, for a
 * caller whose client treats null as a real answer (fetchPremiereState, which
 * the viewer's ended screen polls): one database blip must not read as "you
 * have no access". Off by default, where null and a throw end the same way.
 */
async function gateVisible(
  eventId: string,
  opts?: { throwOnError?: boolean },
): Promise<RoomGate | null> {
  const access = await resolveEventAccess(eventId);
  if (!access.ok) {
    if (access.reason === "error" && opts?.throwOnError) {
      throw new Error("Couldn't reach the server — try again.");
    }
    return null;
  }
  if (!isHostedOnBatch0(access.event.liveMode)) return null;
  const ev = access.event;
  return {
    eventId: ev.id,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    liveMode: ev.liveMode,
    audienceMode: ev.audienceMode,
    premiereSeconds: ev.premiereSeconds,
    qaOpensAt: ev.qaOpensAt,
    liveStartedAt: ev.liveStartedAt,
    liveEndedAt: ev.liveEndedAt,
    userId: access.userId,
    isModerator: access.isHost,
    isStaff: access.isStaff,
    isSpeaker: access.isSpeaker,
    access: await roomAccessFor(access),
  };
}

/**
 * Role, visibility, AND the caller's window — the gate for every read and
 * write in the room.
 *
 * The window is `roomAccess`, per role: a moderator's is start-60m to end+3h
 * whatever End says (so staff keep moderating an overrunning webinar and can
 * reach the ended screen), a viewer's is the audience window, extended while a
 * host is present. A viewer is ALSO let through once the webinar has ended,
 * up to the hard stop, but only to READ: that is how the ended screen's slow
 * poll learns about a Reopen. Every audience write below refuses once
 * `liveEndedAt` is set.
 */
async function gateRoom(
  eventId: string,
  opts?: { throwOnError?: boolean },
): Promise<RoomGate | null> {
  const gate = await gateVisible(eventId, opts);
  if (!gate) return null;
  if (roomIsOpen(gate.access)) return gate;
  if (gate.access === "ended" && withinHardClose(gate)) return gate;
  return null;
}

/** The refusal every audience write gives once the host has pressed End. */
function refuseIfEnded(gate: RoomGate): void {
  if (gate.liveEndedAt && !gate.isModerator) {
    throw new Error("This webinar has ended.");
  }
}

/**
 * May the caller end this webinar for everyone, right now?
 *
 * Staff: always. A guest speaker: only when no staff host is present (see
 * canEndForEveryone). Who among the present hosts is staff is decided by each
 * one's own role (presentHostRoles) — not by "not on the speaker list", which
 * let a guest end a room run by an admin who happened to hold a speaker row.
 * An unreadable attendance table counts as no staff present, so the rule
 * fails open for speakers — ending is reversible by staff, and failing closed
 * would strand a guest-only webinar with nobody able to close it.
 */
async function canEnd(gate: RoomGate): Promise<boolean> {
  if (gate.isStaff) return true;
  if (!gate.isSpeaker) return false;
  const hosts = await presentHostRoles(gate.eventId);
  const staffPresent =
    !!hosts && hosts.some((h) => h.isStaff && h.userId !== gate.userId);
  return canEndForEveryone({
    isStaff: false,
    isSpeaker: true,
    staffPresent,
  });
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
   * Set once a host has pressed End for everyone.
   *
   * This is what lets a viewer be TOLD the webinar is over instead of being
   * left on "waiting for the host to start" until the join window closes half
   * an hour later. It has to come from the server: anything on the public
   * stage channel can be forged by a student in devtools, so the stage only
   * ever carries a content-free `room-changed` hint, and the client acts on
   * this column. A column the server stamps is the signal with an author.
   */
  liveEndedAt: string | null;
  /**
   * May the reader end the webinar for everyone right now? Staff always; a
   * guest speaker only while no staff host is present. See canEndForEveryone.
   */
  canEnd: boolean;
  /** Staff host (events.manage) — owns Reopen and recording. */
  isStaff: boolean;
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
  const mayEnd = await canEnd(gate);

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
    canEnd: mayEnd,
    isStaff: gate.isStaff,
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
  // After End the room is closed to the audience: nobody is left to moderate
  // a `moderated` room, and an `open` one would carry on with no host in it.
  // Hosts may still post (a closing note to whoever is still reading).
  refuseIfEnded(gate);
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
  refuseIfEnded(gate);
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

/**
 * Move a question out of the queue (answered / dismissed), or back into it.
 * Moderators only — staff and guest speakers alike.
 *
 * The event-scoped successor to the old `setQuestionStatus(id, status)` in
 * ./actions.ts, which gated on `events.manage` alone: a guest speaker was
 * shown the host question panel and every Answered / Dismiss click threw
 * Forbidden. It now runs the same gate as every other moderation action, and
 * the update is scoped to the gated event, so a moderator of one webinar
 * cannot touch another's question by id.
 */
export async function setQuestionStatus(
  eventId: string,
  questionId: string,
  status: QuestionStatus,
): Promise<void> {
  const gate = await gateRoom(eventId);
  if (!gate?.isModerator) throw new Error("Forbidden");
  const admin = createAdminClient();
  const { error } = await admin
    .from("webinar_questions")
    .update({
      status,
      resolved_by: status === "open" ? null : gate.userId,
    })
    .eq("id", questionId)
    .eq("event_id", eventId);
  if (error) throw new Error(error.message);
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
  refuseIfEnded(gate);
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
// The premiere handover, End for everyone, and Reopen
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
 * Moderators, inside the host window (so a host setting up early can go live
 * early). Refused once the webinar has been ended: going live is not a way
 * back into an ended room — Reopen is, and it is staff's call.
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
  if (gate.liveEndedAt) {
    throw new Error("This webinar has ended — reopen it first.");
  }
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
 * End the webinar for everyone. Returns the stored `live_ended_at`.
 *
 * The server half of the one End control (BroadcastRoom's arm/confirm button,
 * and the admin list's End for everyone). It is a server stamp rather than a
 * local teardown because a host who has ended and a host who has dropped off
 * hotel wifi look identical from every other browser — only a column the
 * server writes can tell the audience the webinar is over.
 *
 * Who: staff always; a guest speaker only when no staff host is present (see
 * canEnd). A founder who presses End thinking it ends their segment must not
 * end a room an admin is running.
 *
 * When: never window-gated — an overrunning webinar must always be endable —
 * but bounded by the hard stop (end + 3h).
 *
 * What, in order:
 *   1. Stamp `live_ended_at` ONLY IF it is not already set, then read back the
 *      stored value. The first End wins; two hosts pressing End (or a retry)
 *      no longer produce a moving timestamp.
 *   2. Close every open poll — a vote after End is a vote nobody will read.
 *   3. Close every open attendance row at the stored time, so tabs left open
 *      on the ended screen stop accruing minutes (announcePresence also stops
 *      touching attendance for an ended event).
 *   4. Tell the room: a content-free `room-changed` on the public stage topic,
 *      which EVERY participant holds — co-hosts, speakers, and viewers in a
 *      `private` room who have no room topic — so each engine re-asks the
 *      server, hears 'ended', and tears down within a second or two instead of
 *      on the 8-second poll. Plus `stage-change` and a poll bump on the room
 *      topic for the panels.
 *
 * After this, joinRoom and announcePresence refuse the room for everyone
 * (status 'ended'), audience writes refuse, and lists show "Ended". The client
 * flushes its recorder and stops its tracks AFTER this resolves; if it throws,
 * the host stays live and can retry.
 *
 * Reversible, but only deliberately: staff press Reopen. Pressing Start again
 * does NOT reopen an ended webinar.
 */
export async function endLive(eventId: string): Promise<string> {
  const gate = await gateVisible(eventId);
  if (!gate?.isModerator) throw new Error("Forbidden");
  if (!withinHardClose(gate)) {
    throw new Error("This webinar closed a while ago.");
  }
  if (!(await canEnd(gate))) {
    throw new Error(
      "A staff host is running this webinar — use Leave to step out.",
    );
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("events")
    .update({ live_ended_at: now })
    .eq("id", eventId)
    .is("live_ended_at", null)
    .select("live_ended_at")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const firstEnd = !!data;
  const stored: string =
    (data as any)?.live_ended_at ?? (await readLiveEndedAt(eventId)) ?? now;

  if (firstEnd) {
    // Best-effort: the stamp above is what ends the webinar. A poll left open
    // is closed by staff in a click; failing End over it would strand the
    // host in a room they are trying to leave.
    const { error: pollError } = await admin
      .from("webinar_polls")
      .update({ open: false })
      .eq("event_id", eventId)
      .eq("open", true);
    if (pollError) {
      console.error("[webinars] closing polls on end failed", pollError.message);
    }
    await closeOpenAttendance(eventId, stored);
    await logAudit({
      action: "event.live_ended",
      targetType: "event",
      targetId: eventId,
      payload: { byStaff: gate.isStaff },
    });
  }

  // Sent on every call, not only the first: a retry after a dropped broadcast
  // is exactly when a client might still be waiting to hear.
  await notifyStage(`event:${eventId}`, { t: "room-changed" });
  await notifyRoom(`event:${eventId}`, { t: "stage-change" });
  await notifyRoom(`event:${eventId}`, { t: "bump", what: "poll" });
  return stored;
}

/**
 * Undo an End. Staff only.
 *
 * Deliberately not open to guest speakers: reopening a room staff closed is a
 * decision about the room, not about one segment of it. Bounded by the hard
 * stop like End, and not otherwise window-gated, so staff can also clear a
 * stale stamp from the admin pages.
 *
 * Clears the stamp and sends `room-changed` on the stage (plus `stage-change`
 * on the room topic). Hosts on the ended screen go back to the green room;
 * viewers on theirs see the reopen on their next slow poll or on the hint and
 * are offered Rejoin. Nothing reconnects anyone automatically.
 */
export async function reopenLive(eventId: string): Promise<void> {
  const gate = await gateVisible(eventId);
  if (!gate?.isStaff) throw new Error("Forbidden");
  if (!withinHardClose(gate)) {
    throw new Error("This webinar closed a while ago.");
  }
  const admin = createAdminClient();
  const { error } = await admin
    .from("events")
    .update({ live_ended_at: null })
    .eq("id", eventId);
  if (error) throw new Error(error.message);
  if (gate.liveEndedAt) {
    await logAudit({
      action: "event.live_reopened",
      targetType: "event",
      targetId: eventId,
    });
  }
  await notifyStage(`event:${eventId}`, { t: "room-changed" });
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

async function readLiveEndedAt(eventId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("events")
    .select("live_ended_at")
    .eq("id", eventId)
    .maybeSingle();
  return (data as any)?.live_ended_at ?? null;
}

/**
 * The room's live state, according to the server: where a premiere is, whether
 * the webinar has been ended, and what the reader may do about it.
 *
 * Polled by the room while live (a backstop to the stage hint and the
 * `stage-change` bump), slowly from a viewer's ended screen to notice a
 * Reopen, and re-read before any client acts on a hint.
 *
 * For a premiere the seek offset MUST come from here and not from the browser.
 * A viewer whose laptop clock is four minutes fast would otherwise sit four
 * minutes ahead of everyone else — visibly, in chat, reacting to something
 * nobody has seen yet — and a viewer whose clock is wrong by an hour would see
 * a black screen and conclude the webinar never started.
 *
 * For every other event the phase is 'live' (or 'ended'): only a premiere has
 * a recording to wait for. The premiere length is passed only when the event
 * IS a premiere, so a hosted webinar that once had a premiere file attached is
 * never mistaken for one.
 *
 * Null means "not in the room right now", never "could not tell": a failed
 * access read THROWS, so the client's catch retries it. Null is also not
 * "never" — a viewer after a Reopen past end+30m gets null until a host is
 * back on air — which is why the ended screen keeps polling through it until
 * the hard stop instead of taking the first null as final.
 */
export async function fetchPremiereState(eventId: string) {
  const gate = await gateRoom(eventId, { throwOnError: true });
  if (!gate) return null;
  const premiere = isPremiere(gate.liveMode);
  return {
    ...premiereState({
      startsAt: gate.startsAt,
      premiereSeconds: premiere ? gate.premiereSeconds : null,
      qaOpensAt: premiere ? gate.qaOpensAt : null,
      liveStartedAt: gate.liveStartedAt,
      liveEndedAt: gate.liveEndedAt,
      endsAt: gate.endsAt,
    }),
    liveStartedAt: gate.liveStartedAt,
    liveEndedAt: gate.liveEndedAt,
    canEnd: await canEnd(gate),
    isStaff: gate.isStaff,
    // Sent so the client can measure its own clock against the server's and
    // say so in the console when they disagree — a four-minute skew is
    // otherwise invisible and presents as "the video is out of sync for one
    // student", which is unreproducible by anyone else.
    serverNow: new Date().toISOString(),
  };
}
