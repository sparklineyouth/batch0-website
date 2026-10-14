import "server-only";
import { unstable_rethrow } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { notifyModerators, notifyRoom } from "@/lib/live-rooms";
import { normalizeQuestion, roomIsOpen } from "@/lib/live";
import {
  audienceCanSeeEachOther,
  messagesNeedApproval,
  normalizeChatMessage,
  normalizePoll,
  CHAT_BURST_LIMIT,
  CHAT_DELETE_LIMIT,
  CHAT_DELETE_WINDOW_SECONDS,
  VOTE_LIMIT,
  VOTE_WINDOW_SECONDS,
  type ChatMessage,
  type RoomQuestion,
} from "@/lib/webinars";
import {
  chatRemovedHint,
  isUuid,
  QUESTION_STATUSES,
  type ChatModeration,
  type PanelOp,
  type PanelOpResult,
  type PanelWrite,
  type QuestionState,
} from "@/lib/webinar-panel";
import { endedForAudience, gateRoom, type RoomGate } from "@/lib/webinar-gate";

/**
 * The webinar side panel's writes: chat, Q&A and polls. Called by
 * POST /api/live/panel (runPanelWrite) — a route, not server actions, so a
 * send never queues behind the engine's heartbeat in Next's serial action
 * queue.
 *
 * Every write re-runs the room gate (lib/webinar-gate.ts). Writes use the
 * service role with the event id in every filter, so a host of one webinar
 * cannot touch another's rows by id. After a write the server publishes a
 * content-free hint on the room or moderation topic (a removal carries the
 * removed row's id, nothing more); clients answer it by re-reading under
 * their own gate.
 *
 * Writes return `PanelWrite` instead of throwing: the panel needs the real
 * reason, and whether to retry.
 */

/** Run one parsed write for the signed-in caller. */
export async function runPanelWrite<O extends PanelOp>(
  eventId: string,
  op: O,
): Promise<PanelWrite<PanelOpResult<O["op"]>>> {
  return (await dispatch(eventId, op)) as PanelWrite<PanelOpResult<O["op"]>>;
}

function dispatch(eventId: string, o: PanelOp): Promise<PanelWrite<unknown>> {
  switch (o.op) {
    case "chat.send":
      return sendChatMessage(eventId, { id: o.id, body: o.body });
    case "chat.delete":
      return deleteChatMessage(eventId, o.id);
    case "chat.moderate":
      return moderateChatMessage(eventId, o.id, o.action);
    case "qa.ask":
      return askQuestion(eventId, { id: o.id, body: o.body });
    case "qa.vote":
      return voteOnQuestion(eventId, o.id, o.on);
    case "qa.spotlight":
      return spotlightQuestion(eventId, o.id, o.on);
    case "qa.status":
      return setQuestionStatus(eventId, o.id, o.status);
    case "qa.approve":
      return approveQuestion(eventId, o.id);
    case "poll.create":
      return createPoll(eventId, o);
    case "poll.open":
      return setPollOpen(eventId, o.id, o.open);
    case "poll.vote":
      return voteOnPoll(eventId, o.id, o.choice);
  }
}

/** A refusal the person should read. `retryInMs` marks one worth retrying. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly retryInMs?: number,
  ) {
    super(message);
  }
}

async function attempt<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<PanelWrite<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Refusal) {
      return err.retryInMs
        ? { ok: false, error: err.message, retryInMs: err.retryInMs }
        : { ok: false, error: err.message };
    }
    console.error(`[room:${name}]`, err);
    return { ok: false, error: "Couldn't reach the server.", retryInMs: 2_000 };
  }
}

const roomOf = (eventId: string) => `event:${eventId}`;
const UNIQUE_VIOLATION = "23505";

async function requireRoom(eventId: string): Promise<RoomGate> {
  // A failed access read throws (retryable), rather than reading as "not yours".
  const gate = isUuid(eventId) ? await gateRoom(eventId, { throwOnError: true }) : null;
  if (!gate) throw new Refusal("This room isn't open to you right now.");
  return gate;
}

async function requireModerator(eventId: string): Promise<RoomGate> {
  const gate = await requireRoom(eventId);
  if (!gate.isModerator) throw new Refusal("Only hosts can do that.");
  return gate;
}

function requireId(id: unknown): string {
  if (!isUuid(id)) throw new Refusal("That item doesn't exist.");
  return id;
}

function check(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

/** Every vote bumps the room; a hand toggling one is capped. */
async function limitVotes(gate: RoomGate): Promise<void> {
  const limited = await checkRateLimit({
    kind: "webinar-vote",
    identifier: `${gate.eventId}:${gate.userId}`,
    limit: VOTE_LIMIT,
    windowSeconds: VOTE_WINDOW_SECONDS,
  });
  if (!limited.ok) throw new Refusal("Slow down a moment.");
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * Say something. `id` is minted by the client so a retried send is
 * idempotent: a second insert hits the primary key and is answered with the
 * row the first one stored.
 *
 * The RLS insert policy (0084) carries the same CHAT_BURST_LIMIT for anyone
 * writing with their own JWT; this check is what turns it into a sentence.
 */
export async function sendChatMessage(
  eventId: string,
  input: { id: string; body: string },
): Promise<PanelWrite<ChatMessage>> {
  return attempt("send-chat", async () => {
    const gate = await requireRoom(eventId);
    if (endedForAudience(gate)) throw new Refusal("This webinar has ended.");
    if (!audienceCanSeeEachOther(gate.audienceMode)) {
      throw new Refusal("Chat is off for this webinar.");
    }
    const id = requireId(input?.id);
    const body = normalizeChatMessage(String(input?.body ?? ""));
    if (!body) throw new Refusal("Write something first.");

    const limited = await checkRateLimit({
      kind: "webinar-chat",
      identifier: `${eventId}:${gate.userId}`,
      limit: CHAT_BURST_LIMIT,
      windowSeconds: 10,
    });
    if (!limited.ok) throw new Refusal("Slow down a moment.", 3_000);

    // A host's own message is live at once; in a moderated room a viewer's
    // waits for a host.
    const approvedNow =
      gate.isModerator || !messagesNeedApproval(gate.audienceMode);
    const admin = createAdminClient();
    const columns = "id, body, is_host, approved_at, pinned, created_at";
    const inserted = await admin
      .from("webinar_messages")
      .insert({
        id,
        event_id: eventId,
        author_id: gate.userId,
        body,
        // Snapshotted: a host who later loses the role stays a host in the log.
        is_host: gate.isModerator,
        approved_at: approvedNow ? new Date().toISOString() : null,
      })
      .select(columns)
      .single();
    let row = inserted.data as any;
    if (inserted.error?.code === UNIQUE_VIOLATION) {
      // A retry of a send that landed. Answer with the stored row — but only
      // the caller's own, in this event.
      const { data } = await admin
        .from("webinar_messages")
        .select(columns)
        .eq("id", id)
        .eq("event_id", eventId)
        .eq("author_id", gate.userId)
        .maybeSingle();
      if (!data) throw new Refusal("Couldn't send — try again.");
      row = data;
    } else {
      check(inserted.error);
      const hint = { t: "bump" as const, what: "chat" as const, cursor: row.created_at };
      if (row.approved_at) await notifyRoom(roomOf(eventId), hint);
      else await notifyModerators(roomOf(eventId), hint);
    }
    return {
      id: row.id,
      authorName: "You",
      mine: true,
      body: row.body,
      isHost: !!row.is_host,
      approvedAt: row.approved_at ?? null,
      removedAt: null,
      pinned: !!row.pinned,
      createdAt: row.created_at,
    };
  });
}

/** Take back your own message. Works after End too — it is yours. */
export async function deleteChatMessage(
  eventId: string,
  messageId: string,
): Promise<PanelWrite> {
  return attempt("delete-chat", async () => {
    const gate = await requireRoom(eventId);
    const id = requireId(messageId);
    const limited = await checkRateLimit({
      kind: "webinar-chat-delete",
      identifier: `${eventId}:${gate.userId}`,
      limit: CHAT_DELETE_LIMIT,
      windowSeconds: CHAT_DELETE_WINDOW_SECONDS,
    });
    if (!limited.ok) throw new Refusal("Slow down a moment.", 5_000);

    const admin = createAdminClient();
    const { data, error } = await admin
      .from("webinar_messages")
      .update({ removed_at: new Date().toISOString(), pinned: false })
      .eq("id", id)
      .eq("event_id", eventId)
      .eq("author_id", gate.userId)
      .is("removed_at", null)
      .select("id");
    check(error);
    if (!data?.length) {
      // Already gone (a retry, a second tab) is success; someone else's is not.
      const { data: own } = await admin
        .from("webinar_messages")
        .select("id")
        .eq("id", id)
        .eq("event_id", eventId)
        .eq("author_id", gate.userId)
        .maybeSingle();
      if (!own) throw new Refusal("You can only delete your own messages.");
      return null;
    }
    // Tell the room first: the audit row can land a beat later.
    await notifyRoom(roomOf(eventId), chatRemovedHint(id));
    await logAudit({
      action: "webinar.chat_deleted",
      targetType: "webinar_message",
      targetId: id,
      payload: { eventId },
    });
    return null;
  });
}

/** Approve, remove, pin or unpin a message. Hosts only. */
export async function moderateChatMessage(
  eventId: string,
  messageId: string,
  action: ChatModeration,
): Promise<PanelWrite> {
  return attempt("moderate-chat", async () => {
    const gate = await requireModerator(eventId);
    const id = requireId(messageId);
    const admin = createAdminClient();
    const now = new Date().toISOString();
    // Every write is scoped to this event and to rows still standing: a
    // removed message cannot be approved or pinned back into the room.
    const row = () => admin.from("webinar_messages");

    if (action === "remove") {
      const { data, error } = await row()
        .update({ removed_at: now, pinned: false })
        .eq("id", id)
        .eq("event_id", eventId)
        .is("removed_at", null)
        .select("id");
      check(error);
      await notifyRoom(roomOf(eventId), chatRemovedHint(id));
      if (data?.length) {
        await logAudit({
          action: "webinar.chat_removed",
          targetType: "webinar_message",
          targetId: id,
          payload: { eventId, byStaff: gate.isStaff },
        });
      }
      return null;
    }

    if (action === "approve") {
      check(
        (
          await row()
            .update({ approved_at: now })
            .eq("id", id)
            .eq("event_id", eventId)
            .is("removed_at", null)
            .is("approved_at", null)
        ).error,
      );
    } else if (action === "pin") {
      // Unpin first: the worst interleaving leaves no pin, never two.
      check(
        (
          await row()
            .update({ pinned: false })
            .eq("event_id", eventId)
            .eq("pinned", true)
        ).error,
      );
      check(
        (
          await row()
            .update({ pinned: true })
            .eq("id", id)
            .eq("event_id", eventId)
            .is("removed_at", null)
        ).error,
      );
      // Pinning shows it to the whole room, so it is approved too.
      check(
        (
          await row()
            .update({ approved_at: now })
            .eq("id", id)
            .eq("event_id", eventId)
            .is("approved_at", null)
        ).error,
      );
    } else if (action === "unpin") {
      check(
        (
          await row()
            .update({ pinned: false })
            .eq("id", id)
            .eq("event_id", eventId)
        ).error,
      );
    } else {
      throw new Refusal("Unknown action.");
    }
    // No cursor: the change is behind everyone's cursor, so a full read.
    await notifyRoom(roomOf(eventId), { t: "bump", what: "chat" });
    return null;
  });
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** Spam ceiling per asker per event, not a participation limit. */
const MAX_QUESTIONS_PER_ASKER = 40;

/** Ask the hosts something. `id` is client-minted, like a chat send. */
export async function askQuestion(
  eventId: string,
  input: { id: string; body: string },
): Promise<PanelWrite<RoomQuestion>> {
  return attempt("ask", async () => {
    const gate = await requireRoom(eventId);
    if (gate.liveEndedAt) throw new Refusal("This webinar has ended.");
    if (!roomIsOpen(gate.access)) {
      throw new Refusal("Questions are open only while the webinar is live.");
    }
    const id = requireId(input?.id);
    const body = normalizeQuestion(String(input?.body ?? ""));
    if (!body) throw new Refusal("Write a question first.");

    const admin = createAdminClient();
    const { count } = await admin
      .from("webinar_questions")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId)
      .eq("asker_id", gate.userId);
    if ((count ?? 0) >= MAX_QUESTIONS_PER_ASKER) {
      throw new Refusal("You've asked plenty for now.");
    }

    // Visibility is decided at INSERT: a question asked while the room was
    // private stays unapproved even if the room is opened up later.
    const approvedNow = gate.audienceMode === "open";
    const columns = "id, body, status, approved_at, created_at";
    const inserted = await admin
      .from("webinar_questions")
      .insert({
        id,
        event_id: eventId,
        asker_id: gate.userId,
        body,
        approved_at: approvedNow ? new Date().toISOString() : null,
      })
      .select(columns)
      .single();
    let row = inserted.data as any;
    if (inserted.error?.code === UNIQUE_VIOLATION) {
      const { data } = await admin
        .from("webinar_questions")
        .select(columns)
        .eq("id", id)
        .eq("event_id", eventId)
        .eq("asker_id", gate.userId)
        .maybeSingle();
      if (!data) throw new Refusal("Couldn't send — try again.");
      row = data;
    } else {
      check(inserted.error);
      const hint = { t: "bump" as const, what: "qa" as const };
      if (row.approved_at) await notifyRoom(roomOf(eventId), hint);
      else await notifyModerators(roomOf(eventId), hint);
    }
    return {
      id: row.id,
      askerName: "You",
      mine: true,
      body: row.body,
      status: row.status,
      voteCount: 0,
      voted: false,
      spotlighted: false,
      approvedAt: row.approved_at ?? null,
      createdAt: row.created_at,
    };
  });
}

/**
 * Upvote, or take it back. Only where the audience can see each other's
 * questions, on a question the voter can see that isn't their own. A vote is
 * a row; the trigger in 0084 recounts `vote_count`.
 */
export async function voteOnQuestion(
  eventId: string,
  questionId: string,
  on: boolean,
): Promise<PanelWrite> {
  return attempt("vote-question", async () => {
    const gate = await requireRoom(eventId);
    if (endedForAudience(gate)) throw new Refusal("This webinar has ended.");
    if (!audienceCanSeeEachOther(gate.audienceMode)) {
      throw new Refusal("Upvotes are off for this webinar.");
    }
    const id = requireId(questionId);
    const admin = createAdminClient();
    const { data: q } = await admin
      .from("webinar_questions")
      .select("asker_id, approved_at")
      .eq("id", id)
      .eq("event_id", eventId)
      .maybeSingle();
    const question = q as { asker_id: string; approved_at: string | null } | null;
    if (!question || (!question.approved_at && !gate.isModerator)) {
      throw new Refusal("That question isn't open for votes.");
    }
    if (question.asker_id === gate.userId) {
      throw new Refusal("You can't upvote your own question.");
    }
    await limitVotes(gate);
    if (on) {
      check(
        (
          await admin
            .from("webinar_question_votes")
            .upsert(
              { question_id: id, voter_id: gate.userId },
              { onConflict: "question_id,voter_id", ignoreDuplicates: true },
            )
        ).error,
      );
    } else {
      check(
        (
          await admin
            .from("webinar_question_votes")
            .delete()
            .eq("question_id", id)
            .eq("voter_id", gate.userId)
        ).error,
      );
    }
    await notifyRoom(roomOf(eventId), { t: "bump", what: "qa" });
    return null;
  });
}

/** Feature one question for the room (approving it), or take it down. Hosts. */
export async function spotlightQuestion(
  eventId: string,
  questionId: string,
  on: boolean,
): Promise<PanelWrite> {
  return attempt("spotlight", async () => {
    await requireModerator(eventId);
    const id = requireId(questionId);
    const admin = createAdminClient();
    // One spotlight at a time: clear first, so a race leaves none, not two.
    check(
      (
        await admin
          .from("webinar_questions")
          .update({ spotlighted: false })
          .eq("event_id", eventId)
          .eq("spotlighted", true)
      ).error,
    );
    if (on) {
      check(
        (
          await admin
            .from("webinar_questions")
            .update({ spotlighted: true, approved_at: new Date().toISOString(), status: "open" })
            .eq("id", id)
            .eq("event_id", eventId)
        ).error,
      );
    }
    await notifyRoom(roomOf(eventId), { t: "bump", what: "qa" });
    return null;
  });
}

/** Answered / dismissed, or back into the queue. Hosts. */
export async function setQuestionStatus(
  eventId: string,
  questionId: string,
  status: QuestionState,
): Promise<PanelWrite> {
  return attempt("question-status", async () => {
    const gate = await requireModerator(eventId);
    const id = requireId(questionId);
    if (!QUESTION_STATUSES.includes(status)) throw new Refusal("Unknown status.");
    const admin = createAdminClient();
    check(
      (
        await admin
          .from("webinar_questions")
          .update({
            status,
            resolved_by: status === "open" ? null : gate.userId,
            // Out of the queue is out of the spotlight.
            ...(status === "open" ? {} : { spotlighted: false }),
          })
          .eq("id", id)
          .eq("event_id", eventId)
      ).error,
    );
    await notifyRoom(roomOf(eventId), { t: "bump", what: "qa" });
    return null;
  });
}

/** Let a held question through to the room. Hosts. */
export async function approveQuestion(
  eventId: string,
  questionId: string,
): Promise<PanelWrite> {
  return attempt("approve-question", async () => {
    await requireModerator(eventId);
    const id = requireId(questionId);
    const admin = createAdminClient();
    check(
      (
        await admin
          .from("webinar_questions")
          .update({ approved_at: new Date().toISOString() })
          .eq("id", id)
          .eq("event_id", eventId)
          .is("approved_at", null)
      ).error,
    );
    await notifyRoom(roomOf(eventId), { t: "bump", what: "qa" });
    return null;
  });
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

/** Create a poll, open now or saved as a draft only hosts see. Hosts. */
export async function createPoll(
  eventId: string,
  input: { question: string; options: string[]; resultsVisible: boolean; open: boolean },
): Promise<PanelWrite<string>> {
  return attempt("create-poll", async () => {
    const gate = await requireModerator(eventId);
    const cleaned = normalizePoll({
      question: String(input?.question ?? ""),
      options: Array.isArray(input?.options) ? input.options.map(String) : [],
    });
    if (!cleaned.ok) throw new Refusal(cleaned.error);
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("webinar_polls")
      .insert({
        event_id: eventId,
        question: cleaned.question,
        options: cleaned.options,
        results_visible: input.resultsVisible !== false,
        created_by: gate.userId,
        open: !!input.open,
      })
      .select("id")
      .single();
    check(error);
    // An open poll is news for the room; a draft only for the other hosts.
    if (input.open) {
      await notifyRoom(roomOf(eventId), { t: "bump", what: "poll" });
    } else {
      await notifyModerators(roomOf(eventId), { t: "bump", what: "poll" });
    }
    return (data as { id: string }).id;
  });
}

export async function setPollOpen(
  eventId: string,
  pollId: string,
  open: boolean,
): Promise<PanelWrite> {
  return attempt("poll-open", async () => {
    await requireModerator(eventId);
    const id = requireId(pollId);
    const admin = createAdminClient();
    check(
      (
        await admin
          .from("webinar_polls")
          .update({ open: !!open })
          .eq("id", id)
          .eq("event_id", eventId)
      ).error,
    );
    await notifyRoom(roomOf(eventId), { t: "bump", what: "poll" });
    return null;
  });
}

export async function voteOnPoll(
  eventId: string,
  pollId: string,
  choice: number,
): Promise<PanelWrite> {
  return attempt("vote-poll", async () => {
    const gate = await requireRoom(eventId);
    if (endedForAudience(gate)) throw new Refusal("This webinar has ended.");
    const id = requireId(pollId);
    const admin = createAdminClient();
    // Bounded against this poll's own options (RLS does too); also what stops
    // a vote landing on a poll the host has just closed.
    const { data: poll } = await admin
      .from("webinar_polls")
      .select("options, open")
      .eq("id", id)
      .eq("event_id", eventId)
      .maybeSingle();
    const p = poll as { options: unknown; open: boolean } | null;
    if (!p?.open) throw new Refusal("That poll is closed.");
    if (
      !Array.isArray(p.options) ||
      !Number.isInteger(choice) ||
      choice < 0 ||
      choice >= p.options.length
    ) {
      throw new Refusal("That isn't one of the options.");
    }
    await limitVotes(gate);
    check(
      (
        await admin
          .from("webinar_poll_votes")
          .upsert(
            { poll_id: id, voter_id: gate.userId, choice },
            { onConflict: "poll_id,voter_id" },
          )
      ).error,
    );
    await notifyRoom(roomOf(eventId), { t: "bump", what: "poll" });
    return null;
  });
}
