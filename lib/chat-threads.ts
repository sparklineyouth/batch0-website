import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import type { Capabilities } from "@/lib/permissions";
import { requesterThreadPath, supportScopeFor } from "@/lib/support-access";
import type { ChatViewer } from "@/lib/chat-access";
import { getPeople, type ChannelRow } from "@/lib/chat";
import { THREAD_COLS, noteThreadsMissing, threadsReady, toThreadRow, type ThreadRow } from "@/lib/chat-thread-rows";
import {
  THREAD_BELL_TYPES,
  canDecideQuestion,
  helpReferenceFor,
  helpStatusFor,
  isFollowing,
  isQuestionChannel,
  threadLink,
  type AboutChip,
  type FollowState,
  type HelpStatus,
  type HelpTicketStatus,
  type QuestionNow,
  type QuestionState,
} from "@/lib/chat-threads-rules";

/**
 * Chat's threads and #help's questions (migration 0110): the service-role
 * reads and writes behind app/chat/actions.ts and the thread GET route.
 * The read-only question lists (#help's Unanswered, the Overview's count)
 * are lib/chat-questions.ts.
 *
 * Every function here takes a channel the caller has ALREADY cleared for the
 * viewer (getChannelForViewer / openChannelFor), and a root it has checked
 * is in that channel: a thread is read by whoever reads its channel, and a
 * follow row grants nothing. The tables are service role only (0110 §7).
 */

export { threadsReady };

/** A thread's Support request, as one viewer may see it (owner and state live on the ticket). */
export type HelpInfo = {
  status: HelpStatus;
  /** Who on the team has it, or null while nobody does. */
  owner: string | null;
  /** The ticket's reference — for the person who asked, and the team. */
  reference: string | null;
  /** Where this viewer can open it: the team's ticket page, or the asker's. Null for anyone else. */
  href: string | null;
  /** This viewer filed it: "waiting on you" rather than "waiting on the asker". */
  yours: boolean;
};

/** Everything the thread pane needs to know about a thread, for one viewer. */
export type ThreadInfo = {
  rootId: string;
  channelId: string;
  /** #help: where questions live, so its posts can be marked, accepted and reopened. */
  questionChannel: boolean;
  question: QuestionState | null;
  answerId: string | null;
  /** The asker or chat staff (canDecideQuestion), in #help. */
  canDecide: boolean;
  following: boolean;
  help: HelpInfo | null;
  about?: AboutChip;
};

export async function getThreadRow(rootId: string): Promise<ThreadRow | null> {
  if (!(await threadsReady())) return null;
  const { data, error } = await createAdminClient().from("chat_threads").select(THREAD_COLS).eq("root_id", rootId).maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) {
      noteThreadsMissing();
      return null;
    }
    throw new Error(`Couldn't load the thread: ${error.message}`);
  }
  return data ? toThreadRow(data) : null;
}

/** Make sure a thread row exists for this root (a question, a help request, a follow, before any reply). */
export async function ensureThreadRow(rootId: string, channelId: string): Promise<void> {
  const { error } = await createAdminClient()
    .from("chat_threads")
    .upsert({ root_id: rootId, channel_id: channelId }, { onConflict: "root_id", ignoreDuplicates: true });
  if (error) throw new Error(`Couldn't start the thread: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Follows
// ---------------------------------------------------------------------------

export async function getFollowState(rootId: string, userId: string): Promise<FollowState> {
  const { data, error } = await createAdminClient()
    .from("chat_thread_follows")
    .select("state")
    .eq("root_id", rootId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new Error(`Couldn't load the thread: ${error.message}`);
  }
  const s = (data as { state?: string | null } | null)?.state;
  return s === "following" || s === "muted" ? s : null;
}

/** Follow, or unfollow on purpose ('muted': replying again won't undo it). */
export async function setFollowState(rootId: string, userId: string, state: "following" | "muted"): Promise<void> {
  const { error } = await createAdminClient()
    .from("chat_thread_follows")
    .upsert({ root_id: rootId, user_id: userId, state }, { onConflict: "root_id,user_id" });
  if (error) throw new Error(`Couldn't save that: ${error.message}`);
}

/**
 * "Had the thread open just now": holds the next bell back (BELL_QUIET_MS),
 * and takes this person's bells for the thread down. Never makes anyone a
 * follower (the row's state is left as it is, or null).
 */
export async function stampThreadSeen(channelId: string, rootId: string, userId: string): Promise<number> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("chat_thread_follows")
    .upsert({ root_id: rootId, user_id: userId, seen_at: new Date().toISOString() }, { onConflict: "root_id,user_id" });
  if (error && !isMissingSchemaError(error)) throw new Error(`Couldn't update the thread: ${error.message}`);
  const { data, error: bellError } = await admin
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("link", threadLink(channelId, rootId))
    .in("type", THREAD_BELL_TYPES as unknown as string[])
    .is("read_at", null)
    .select("id");
  if (bellError) {
    console.error("[chat] clearing thread bells failed", bellError.message);
    return 0;
  }
  return data?.length ?? 0;
}

// ---------------------------------------------------------------------------
// The help request (the Support ticket a thread's "Ask the team" made)
// ---------------------------------------------------------------------------

export type HelpTicket = {
  id: string;
  reference: string;
  status: HelpTicketStatus;
  userId: string | null;
  assignedTo: string | null;
};

export async function getHelpTicket(ticketId: string | null): Promise<HelpTicket | null> {
  if (!ticketId) return null;
  const { data, error } = await createAdminClient()
    .from("support_tickets")
    .select("id, reference, status, user_id, assigned_to")
    .eq("id", ticketId)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new Error(`Couldn't load the help request: ${error.message}`);
  }
  if (!data) return null;
  const r = data as any;
  return { id: r.id, reference: r.reference, status: r.status, userId: r.user_id ?? null, assignedTo: r.assigned_to ?? null };
}

/**
 * The help request as this viewer sees it. Its state and owner are the
 * ticket's (one record, edited in Support only). The team's link opens the
 * ticket for whoever can read Support; the asker's opens their own request;
 * everyone else sees the state and nothing to open — the ticket holds the
 * asker's email, and is theirs and the team's.
 */
export function helpInfoFor(ticket: HelpTicket, ownerName: string | null, viewer: { userId: string; caps: Capabilities | null }): HelpInfo {
  const team = supportScopeFor(viewer.userId, viewer.caps).canView;
  const mine = !!ticket.userId && ticket.userId === viewer.userId;
  return {
    status: helpStatusFor(ticket.status),
    owner: ticket.assignedTo ? ownerName : null,
    reference: helpReferenceFor(ticket, { userId: viewer.userId, team }),
    href: team ? `/admin/support/${ticket.id}` : mine ? requesterThreadPath(ticket.reference) : null,
    yours: mine,
  };
}

async function loadHelpInfo(ticketId: string | null, viewer: { userId: string; caps: Capabilities | null }): Promise<HelpInfo | null> {
  const ticket = await getHelpTicket(ticketId);
  if (!ticket) return null;
  const owner = ticket.assignedTo ? ((await getPeople([ticket.assignedTo])).get(ticket.assignedTo)?.name ?? "Someone on the team") : null;
  return helpInfoFor(ticket, owner, viewer);
}

// ---------------------------------------------------------------------------
// The pane's picture of one thread
// ---------------------------------------------------------------------------

/**
 * One thread for one viewer: its question state and what they may do with
 * it, whether they follow it, and its help request. `root` is the root's
 * row (lib/chat.ts getMessageRow), already checked to be in `channel`.
 */
export async function describeThread(
  viewer: ChatViewer,
  caps: Capabilities | null,
  channel: ChannelRow,
  root: { id: string; sender_id: string | null },
  row: ThreadRow | null,
): Promise<ThreadInfo> {
  const [follow, help] = await Promise.all([
    getFollowState(root.id, viewer.userId),
    loadHelpInfo(row?.helpTicketId ?? null, { userId: viewer.userId, caps }),
  ]);
  const questionChannel = isQuestionChannel(channel.systemKey);
  return {
    rootId: root.id,
    channelId: channel.id,
    questionChannel,
    question: row?.question ?? null,
    answerId: row?.answerId ?? null,
    canDecide: questionChannel && canDecideQuestion(viewer, { senderId: root.sender_id }),
    following: isFollowing(follow),
    help,
  };
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * Move a question from the state the caller saw to the next one, saying who
 * did it — only if nobody moved it in between (an optimistic lock on the
 * state and the answer). 0110 logs the transition in the same statement and
 * checks the answer belongs to the thread. False when it had moved.
 */
export async function changeQuestion(
  rootId: string,
  from: QuestionNow,
  to: QuestionNow,
  actorId: string,
): Promise<boolean> {
  let q = createAdminClient()
    .from("chat_threads")
    .update({
      question: to.question,
      answer_id: to.answerId,
      question_changed_by: actorId,
      question_changed_at: new Date().toISOString(),
    })
    .eq("root_id", rootId);
  q = from.question === null ? q.is("question", null) : q.eq("question", from.question);
  q = from.answerId === null ? q.is("answer_id", null) : q.eq("answer_id", from.answerId);
  const { data, error } = await q.select("root_id");
  if (error) {
    // 23514: 0110's check said the answer isn't a live reply in this thread.
    if ((error as { code?: string }).code === "23514") return false;
    throw new Error(`Couldn't update the question: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

/** Store the course item a new question is about (an id: titles are per viewer, lib/chat-about.ts). */
export async function setThreadAbout(rootId: string, channelId: string, about: { kind: string; id: string }): Promise<void> {
  const { error } = await createAdminClient()
    .from("chat_threads")
    .upsert({ root_id: rootId, channel_id: channelId, about_kind: about.kind, about_id: about.id }, { onConflict: "root_id" });
  if (error) throw new Error(`Couldn't link that: ${error.message}`);
}
