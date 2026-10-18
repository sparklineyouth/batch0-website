import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import type { AboutKind, QuestionState, ThreadSummary } from "@/lib/chat-threads-rules";

/**
 * The lowest layer of Chat's threads (migration 0110): is the schema there,
 * and the thread rows for a page of messages. No imports from lib/chat.ts,
 * so lib/chat.ts can use it to put "4 replies" on the messages it reads.
 *
 * Production may get this code before 0110 runs. Until then there is no
 * chat_threads table and no thread_root_id column: every read here says
 * "no threads", and the code above it shows none (lib/chat-send.ts does the
 * same for 0104's column). Asked with a read that returns no rows, and a
 * "not there" is remembered for a minute; once it's there it stays there.
 */

const RECHECK_MS = 60_000;
let readyNow = false;
let missingUntil = 0;

export function noteThreadsMissing(now = Date.now()): void {
  readyNow = false;
  missingUntil = now + RECHECK_MS;
}

/** For tests: forget what this instance found out. */
export function resetThreadsState(): void {
  readyNow = false;
  missingUntil = 0;
}

/**
 * Has 0110 run? Any failure but "it isn't there" answers no for this call
 * only, so a blip never switches threads off for a minute.
 */
export async function threadsReady(): Promise<boolean> {
  if (readyNow) return true;
  if (Date.now() < missingUntil) return false;
  const { error } = await createAdminClient().from("chat_threads").select("root_id").limit(0);
  if (!error) {
    readyNow = true;
    return true;
  }
  if (isMissingSchemaError(error)) noteThreadsMissing();
  return false;
}

/** A chat_threads row as the server reads it. */
export type ThreadRow = {
  rootId: string;
  channelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  question: QuestionState | null;
  answerId: string | null;
  helpTicketId: string | null;
  about: { kind: AboutKind; id: string } | null;
};

export const THREAD_COLS =
  "root_id, channel_id, reply_count, last_reply_at, question, answer_id, help_ticket_id, about_kind, about_id";

export function toThreadRow(r: any): ThreadRow {
  return {
    rootId: r.root_id,
    channelId: r.channel_id,
    replyCount: Number(r.reply_count ?? 0),
    lastReplyAt: r.last_reply_at ?? null,
    question: r.question === "open" || r.question === "answered" ? r.question : null,
    answerId: r.answer_id ?? null,
    helpTicketId: r.help_ticket_id ?? null,
    about: (r.about_kind === "lesson" || r.about_kind === "assignment") && r.about_id ? { kind: r.about_kind, id: r.about_id } : null,
  };
}

/** What a feed row shows of its thread: never the help ticket or the course item (those are per viewer). */
export function toSummary(t: ThreadRow): ThreadSummary {
  return { replyCount: t.replyCount, lastReplyAt: t.lastReplyAt, question: t.question, answerId: t.answerId };
}

/**
 * The thread rows for these messages, keyed by root. Empty before 0110, and
 * on a failed read: a page of messages is worth more without its "4 replies"
 * than not at all (the next resync brings them).
 */
export async function loadThreadRows(rootIds: readonly string[]): Promise<Map<string, ThreadRow>> {
  const out = new Map<string, ThreadRow>();
  const ids = Array.from(new Set(rootIds));
  if (ids.length === 0 || !(await threadsReady())) return out;
  const admin = createAdminClient();
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await admin.from("chat_threads").select(THREAD_COLS).in("root_id", ids.slice(i, i + 150));
    if (error) {
      if (isMissingSchemaError(error)) noteThreadsMissing();
      else console.error("[chat] thread summaries", error.message);
      return out;
    }
    for (const r of data ?? []) {
      const row = toThreadRow(r);
      out.set(row.rootId, row);
    }
  }
  return out;
}
