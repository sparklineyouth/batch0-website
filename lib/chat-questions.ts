import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { getChannelBySystemKey, getMessages, getPeople, type ChannelRow, type ChatMessage } from "@/lib/chat";
import { threadsReady } from "@/lib/chat-thread-rows";
import { QUESTION_CHANNEL_KEY, UNANSWERED_LIST_MAX, type HelpTicketStatus } from "@/lib/chat-threads-rules";

/**
 * #help's open questions (migration 0110), read-only: the Unanswered list in
 * Chat, the count on its header button, and the admin Overview's
 * "Unanswered questions". Nothing here writes, notifies or marks anything
 * seen (lib/attention-server.test.ts holds the Overview's side to that).
 *
 * The callers check the viewer reads the channel first: #help's readers in
 * Chat, chat.manage (every text channel) on the Overview.
 */

/**
 * A channel's open questions — #help's Unanswered list — the ones waiting
 * longest first, as messages with their thread summaries. A question whose
 * message was deleted isn't one any more (0110 retires it), so the count is
 * the list's.
 */
export async function listOpenQuestions(
  channelId: string,
  limit = UNANSWERED_LIST_MAX,
): Promise<{ questions: ChatMessage[]; total: number }> {
  if (!(await threadsReady())) return { questions: [], total: 0 };
  const admin = createAdminClient();
  const { data, error, count } = await admin
    .from("chat_threads")
    .select("root_id", { count: "exact" })
    .eq("channel_id", channelId)
    .eq("question", "open")
    .order("created_at", { ascending: true })
    .order("root_id", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) {
    if (isMissingSchemaError(error)) return { questions: [], total: 0 };
    throw new Error(`Couldn't load the questions: ${error.message}`);
  }
  const ids = ((data ?? []) as { root_id: string }[]).map((r) => r.root_id);
  const order = new Map(ids.map((id, i) => [id, i]));
  const messages = (await getMessages(ids)).filter((m) => !m.threadRootId && m.channelId === channelId);
  messages.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { questions: messages, total: count ?? messages.length };
}

/** How many open questions a channel has (the header's Unanswered count). Zero before 0110 or on a failed read. */
export async function countOpenQuestions(channelId: string): Promise<number> {
  if (!(await threadsReady())) return 0;
  const { count, error } = await createAdminClient()
    .from("chat_threads")
    .select("root_id", { count: "exact", head: true })
    .eq("channel_id", channelId)
    .eq("question", "open");
  if (error) {
    if (!isMissingSchemaError(error)) console.error("[chat] counting open questions", error.message);
    return 0;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// The admin Overview's "Unanswered questions" (lib/attention.ts)
// ---------------------------------------------------------------------------

export type UnansweredRow = {
  rootId: string;
  channelId: string;
  channelName: string | null;
  askerName: string;
  askedAt: string;
  replyCount: number;
  /** The thread's help request, when there is one. */
  help: { status: HelpTicketStatus; assigneeName: string | null } | null;
};

/**
 * #help's open questions for the Overview: the total (what the Unanswered
 * list counts) and the oldest `limit`, with who asked, how many replies, and
 * any help request's state and owner. `ready: false` before 0110 (or with no
 * #help); a failed read throws, so the Overview says "couldn't load" rather
 * than "nothing waiting". The caller has checked the viewer reads #help
 * (chat.manage reads every text channel).
 */
export async function loadUnansweredQuestions(opts: { limit: number }): Promise<{
  ready: boolean;
  total: number;
  help: ChannelRow | null;
  rows: UnansweredRow[];
}> {
  if (!(await threadsReady())) return { ready: false, total: 0, help: null, rows: [] };
  const help = await getChannelBySystemKey(QUESTION_CHANNEL_KEY);
  if (!help) return { ready: false, total: 0, help: null, rows: [] };
  const admin = createAdminClient();
  const { data, error, count } = await admin
    .from("chat_threads")
    .select("root_id, reply_count, help_ticket_id, created_at", { count: "exact" })
    .eq("channel_id", help.id)
    .eq("question", "open")
    .order("created_at", { ascending: true })
    .order("root_id", { ascending: true })
    .limit(Math.max(opts.limit * 3, opts.limit));
  if (error) {
    if (isMissingSchemaError(error)) return { ready: false, total: 0, help: null, rows: [] };
    throw Object.assign(new Error(error.message), { code: error.code });
  }
  const threads = (data ?? []) as { root_id: string; reply_count: number; help_ticket_id: string | null; created_at: string }[];
  const { data: rootRows, error: rootError } = threads.length
    ? await admin.from("chat_messages").select("id, sender_id, created_at, deleted_at").in("id", threads.map((t) => t.root_id))
    : { data: [], error: null };
  if (rootError) throw new Error(rootError.message);
  const roots = (rootRows ?? []) as { id: string; sender_id: string | null; created_at: string; deleted_at: string | null }[];
  const rootBy = new Map(roots.map((r) => [r.id, r]));
  const ticketIds = threads.map((t) => t.help_ticket_id).filter((id): id is string => !!id);
  const tickets = new Map<string, { status: HelpTicketStatus; assigned_to: string | null }>();
  if (ticketIds.length) {
    const { data: rows, error: ticketError } = await admin.from("support_tickets").select("id, status, assigned_to").in("id", ticketIds);
    if (ticketError && !isMissingSchemaError(ticketError)) throw new Error(ticketError.message);
    for (const r of (rows ?? []) as any[]) tickets.set(r.id, { status: r.status, assigned_to: r.assigned_to ?? null });
  }
  const people = await getPeople([
    ...roots.map((r) => r.sender_id),
    ...Array.from(tickets.values()).map((t) => t.assigned_to),
  ]);
  const rows: UnansweredRow[] = [];
  for (const t of threads) {
    const root = rootBy.get(t.root_id);
    if (!root || root.deleted_at) continue;
    const ticket = t.help_ticket_id ? tickets.get(t.help_ticket_id) : undefined;
    rows.push({
      rootId: t.root_id,
      channelId: help.id,
      channelName: help.name,
      askerName: root.sender_id ? (people.get(root.sender_id)?.name ?? "Deleted account") : "Deleted account",
      askedAt: root.created_at,
      replyCount: Number(t.reply_count ?? 0),
      help: ticket
        ? { status: ticket.status, assigneeName: ticket.assigned_to ? (people.get(ticket.assigned_to)?.name ?? "Someone on the team") : null }
        : null,
    });
  }
  return { ready: true, total: count ?? rows.length, help, rows };
}
