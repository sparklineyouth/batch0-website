import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { WebinarQuestion } from "@/lib/live";

/**
 * Reads for webinar Q&A (`webinar_questions`, 0060 + 0084).
 *
 * Service-role reads with explicit filters, so one query can join the asker's
 * name — the CALLER decides the scope and passes it in. RLS on the table is
 * the backstop, never the thing that saves us.
 */

/** A question row with the 0084 columns the queue sorts and moderates by. */
export type QuestionRow = WebinarQuestion & {
  voteCount: number;
  spotlighted: boolean;
  approvedAt: string | null;
};

const SELECT =
  "id, event_id, asker_id, body, status, vote_count, spotlighted, approved_at, created_at, " +
  "asker:profiles!webinar_questions_asker_id_fkey(full_name)";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function toQuestion(row: any): QuestionRow {
  const asker = one<any>(row.asker);
  return {
    id: row.id,
    eventId: row.event_id,
    askerId: row.asker_id,
    askerName: asker?.full_name || "A student",
    body: row.body,
    status: row.status,
    voteCount: Number(row.vote_count ?? 0),
    spotlighted: !!row.spotlighted,
    approvedAt: row.approved_at ?? null,
    createdAt: row.created_at,
  };
}

async function read(
  build: (q: any) => any,
  limit: number,
): Promise<QuestionRow[]> {
  const admin = createAdminClient();
  const { data, error } = await build(
    admin.from("webinar_questions").select(SELECT),
  )
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[webinars] question read failed", error.message);
    return [];
  }
  return (data ?? []).map(toQuestion);
}

/** Every question for one event — the hosts' queue. Oldest first. */
export function listQuestionsForEvent(eventId: string): Promise<QuestionRow[]> {
  return read((q) => q.eq("event_id", eventId), 500);
}

/** One viewer's own questions — all a viewer sees in a `private` room. */
export function listQuestionsForAsker(
  eventId: string,
  askerId: string,
): Promise<QuestionRow[]> {
  return read((q) => q.eq("event_id", eventId).eq("asker_id", askerId), 200);
}

/**
 * What a viewer sees in a `moderated` / `open` room: their own, plus everyone's
 * approved ones, never dismissed ones. The one read that hands one student's
 * words to another — only call it where the audience may see itself.
 */
export function listVisibleQuestions(
  eventId: string,
  readerId: string,
): Promise<QuestionRow[]> {
  return read(
    (q) =>
      q
        .eq("event_id", eventId)
        .or(`approved_at.not.is.null,asker_id.eq.${readerId}`)
        .neq("status", "dismissed"),
    300,
  );
}

/** Which of these questions the reader has upvoted. */
export async function questionsVotedBy(
  readerId: string,
  questionIds: readonly string[],
): Promise<Set<string>> {
  if (questionIds.length === 0) return new Set();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("webinar_question_votes")
    .select("question_id")
    .eq("voter_id", readerId)
    .in("question_id", questionIds as string[]);
  if (error) {
    console.error("[webinars] question vote read failed", error.message);
    return new Set();
  }
  return new Set((data ?? []).map((r: any) => r.question_id as string));
}
