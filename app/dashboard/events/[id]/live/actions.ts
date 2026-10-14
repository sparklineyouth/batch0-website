"use server";
import { requireActor } from "@/lib/server-guards";
import type { QuestionStatus, WebinarQuestion } from "@/lib/live";
import { resolveEventAccess } from "@/lib/live-access";
import { listLegacyQuestions } from "@/lib/webinar-data";
import { newRowId } from "@/lib/webinar-panel";
import {
  askQuestion as askRoomQuestion,
  setQuestionStatus as setRoomQuestionStatus,
} from "@/lib/webinar-panel-writes";

/**
 * The legacy question-only panel's actions (components/live/qa-panel.tsx,
 * used by the Daily room). Thin adapters over lib/webinar-panel-writes.ts,
 * which owns the rules; this file goes when qa-panel.tsx does.
 */

export async function askQuestion(
  eventId: string,
  raw: string,
): Promise<WebinarQuestion> {
  const res = await askRoomQuestion(eventId, { id: newRowId(), body: raw });
  if (!res.ok) throw new Error(res.error);
  const { userId } = await requireActor();
  return {
    id: res.data.id,
    eventId,
    askerId: userId,
    askerName: "You",
    body: res.data.body,
    status: res.data.status,
    createdAt: res.data.createdAt,
  };
}

/**
 * The whole queue for a host (staff or speaker); only their own for anyone
 * else. A guest speaker sees students as "A student" (listLegacyQuestions).
 */
export async function fetchQuestions(
  eventId: string,
): Promise<WebinarQuestion[]> {
  const access = await resolveEventAccess(eventId);
  if (!access.ok) return [];
  return listLegacyQuestions(access);
}

export async function setQuestionStatus(
  eventId: string,
  questionId: string,
  status: QuestionStatus,
): Promise<void> {
  const res = await setRoomQuestionStatus(eventId, questionId, status);
  if (!res.ok) throw new Error(res.error);
}
