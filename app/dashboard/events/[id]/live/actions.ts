"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  normalizeQuestion,
  roomIsOpen,
  type QuestionStatus,
  type WebinarQuestion,
} from "@/lib/live";
import {
  listQuestionsForEvent,
  listQuestionsForAsker,
} from "@/lib/webinar-questions";
import {
  isHostedOnBatch0,
  messagesNeedApproval,
} from "@/lib/webinars";
import { resolveEventAccess, roomAccessFor } from "@/lib/live-access";
import { setQuestionStatus as setQuestionStatusForEvent } from "./room-actions";

/**
 * Server actions for webinar Q&A.
 *
 * Questions never touch the video room — a hidden viewer can't send to Daily's
 * chat without becoming visible, so they come here instead. Each action
 * re-checks what its own job needs, because a server action is its own entry
 * point and the page having rendered proves nothing about who is calling it:
 * `askQuestion` re-runs the full write gate (event visible + hosted webinar +
 * inside the caller's room window + not ended + under the spam cap);
 * `fetchQuestions` gates on visibility and shapes its result by role.
 *
 * The role comes from `resolveEventAccess` (lib/live-access.ts) — the same
 * resolution the page, joinRoom and the room actions use. These actions used
 * to decide "host" with `events.manage` alone, which disagreed with every
 * other check in the room: a guest speaker was shown the host panel, then
 * given only their own questions by the poll (wiping the queue) and Forbidden
 * on every Answered / Dismiss.
 *
 * The audience-privacy rule lives in the read path: `fetchQuestions` returns
 * every question to a host and only the caller's own to a viewer, so a viewer
 * cannot learn that anyone else is here — let alone how many.
 */

/** Guard against one student flooding the host's panel. Generous — this is a
 *  spam ceiling, not a participation limit. */
const MAX_QUESTIONS_PER_ASKER = 40;

export async function askQuestion(
  eventId: string,
  raw: string,
): Promise<WebinarQuestion> {
  const body = normalizeQuestion(raw);
  if (!body) throw new Error("Write a question first.");

  const access = await resolveEventAccess(eventId);
  if (!access.ok) {
    throw new Error(
      access.reason === "error"
        ? "Couldn't reach the server — try again."
        : "You can't post to this event.",
    );
  }
  const event = access.event;
  // A premiere takes questions from its first minute — that is most of what
  // makes it feel live — so this accepts both batch0-hosted modes. The RLS
  // insert policy (0084) was widened in step with it; keep the two together.
  if (!isHostedOnBatch0(event.liveMode)) {
    throw new Error("This event isn't a hosted webinar.");
  }
  // Once a host has pressed End, the room is closed to the audience — nobody
  // is left to answer, and the queue would fill with questions no one reads.
  if (event.liveEndedAt) {
    throw new Error("This webinar has ended.");
  }
  if (!roomIsOpen(await roomAccessFor(access))) {
    throw new Error("Questions are open only while the webinar is live.");
  }

  const admin = createAdminClient();

  const { count } = await admin
    .from("webinar_questions")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId)
    .eq("asker_id", access.userId);
  if ((count ?? 0) >= MAX_QUESTIONS_PER_ASKER) {
    throw new Error("You've asked plenty for now — give the host a chance.");
  }

  // Whether the room may see this question, decided at INSERT time.
  //
  // `approved_at` is the single predicate the read policy (0084) uses, and
  // stamping it here rather than reading the mode at display time is what makes
  // widening a webinar's audience safe: a question asked while the room was
  // `private` is never approved, so it stays hidden to everyone but its asker
  // and the hosts even if an admin later switches the mode to `open`. Students
  // who asked under a private promise are not retroactively published.
  //
  // The flip side is the bug this fixes. In `open` mode nothing else ever sets
  // this column — `spotlightQuestion` does, but only for the one question a
  // host features — so without it the audience of an open webinar could see
  // their own questions and no one else's, which is exactly the private
  // behaviour the mode exists to turn off.
  const mode = event.audienceMode;
  const approvedNow = mode === "open" && !messagesNeedApproval(mode);

  const { data, error } = await admin
    .from("webinar_questions")
    .insert({
      event_id: eventId,
      asker_id: access.userId,
      body,
      approved_at: approvedNow ? new Date().toISOString() : null,
    })
    .select("id, event_id, asker_id, body, status, created_at")
    .single();
  if (error) throw new Error(error.message);

  const row = data as any;
  return {
    id: row.id,
    eventId: row.event_id,
    askerId: row.asker_id,
    // Their own question echoed back; a viewer never sees anyone else's name.
    askerName: "You",
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * The live list, polled by the panel. A host — staff OR a guest speaker on
 * this event — gets the whole room's questions; everyone else gets only their
 * own. The role is `resolveEventAccess().isHost`, the same answer that decides
 * who broadcasts — never anything the client sent.
 */
export async function fetchQuestions(
  eventId: string,
): Promise<WebinarQuestion[]> {
  // Even the host reads through this gate: no permission lets you read
  // questions for an event you otherwise can't see (staff are the one
  // exception resolveEventAccess makes, by design — see lib/live-access.ts).
  const access = await resolveEventAccess(eventId);
  if (!access.ok) return [];

  return access.isHost
    ? listQuestionsForEvent(eventId)
    : listQuestionsForAsker(eventId, access.userId);
}

/**
 * Move a question out of the queue. Moderators (staff or guest speakers).
 *
 * A shim over the event-scoped `setQuestionStatus` in ./room-actions.ts, kept
 * so the legacy Q&A panel can import from here. It used to take `(id, status)`
 * and gate on `events.manage` alone, on the assumption that events.manage
 * holders can see every event (they cannot — the `events read` policy's staff
 * clause is mentor.panel) and that only staff moderate (guest speakers do).
 * Both were wrong; the new signature carries the event so the gate and the
 * update are scoped to it.
 */
export async function setQuestionStatus(
  eventId: string,
  questionId: string,
  status: QuestionStatus,
): Promise<void> {
  await setQuestionStatusForEvent(eventId, questionId, status);
}
