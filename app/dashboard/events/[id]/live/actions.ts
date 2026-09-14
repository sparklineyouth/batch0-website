"use server";
import { requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  normalizeQuestion,
  joinState,
  canJoin,
  type QuestionStatus,
  type WebinarQuestion,
} from "@/lib/live";
import {
  listQuestionsForEvent,
  listQuestionsForAsker,
} from "@/lib/webinar-questions";

/**
 * Server actions for webinar Q&A.
 *
 * Questions never touch the video room — a hidden viewer can't send to Daily's
 * chat without becoming visible, so they come here instead. Each action
 * re-checks what its own job needs, because a server action is its own entry
 * point and the page having rendered proves nothing about who is calling it:
 * `askQuestion` re-runs the full write gate (event visible + hosted webinar +
 * inside the join window + under the spam cap); `fetchQuestions` gates on
 * visibility and shapes its result by role; `setQuestionStatus` gates on the
 * `events.manage` permission. The join-window and spam-cap guards are ALSO in
 * the RLS insert policy (0060) — the anon-key browser client could otherwise
 * write straight to the table and skip this action.
 *
 * The audience-privacy rule lives in the read path: `fetchQuestions` returns
 * every question to a host and only the caller's own to a viewer, so a viewer
 * cannot learn that anyone else is here — let alone how many.
 */

/** Guard against one student flooding the host's panel. Generous — this is a
 *  spam ceiling, not a participation limit. */
const MAX_QUESTIONS_PER_ASKER = 40;

type EventGate = {
  id: string;
  starts_at: string;
  ends_at: string | null;
  live_mode: string;
};

/**
 * Read the event through the caller's own RLS. A null result means "you can't
 * see this event" — the `events read` policy (0005) is the gate — and every
 * caller here treats that as a hard stop, so eligibility to ask or read
 * questions is exactly eligibility to see the event.
 */
async function gateEvent(eventId: string): Promise<EventGate | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("events")
    .select("id, starts_at, ends_at, live_mode")
    .eq("id", eventId)
    .maybeSingle();
  return (data as EventGate | null) ?? null;
}

export async function askQuestion(
  eventId: string,
  raw: string,
): Promise<WebinarQuestion> {
  const actor = await requireActor();

  const body = normalizeQuestion(raw);
  if (!body) throw new Error("Write a question first.");

  const event = await gateEvent(eventId);
  if (!event) throw new Error("You can't post to this event.");
  if (event.live_mode !== "hosted") {
    throw new Error("This event isn't a hosted webinar.");
  }
  if (!canJoin(joinState(event.starts_at, event.ends_at))) {
    throw new Error("Questions are open only while the webinar is live.");
  }

  const admin = createAdminClient();

  const { count } = await admin
    .from("webinar_questions")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId)
    .eq("asker_id", actor.userId);
  if ((count ?? 0) >= MAX_QUESTIONS_PER_ASKER) {
    throw new Error("You've asked plenty for now — give the host a chance.");
  }

  const { data, error } = await admin
    .from("webinar_questions")
    .insert({ event_id: eventId, asker_id: actor.userId, body })
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
 * The live list, polled by the panel. Host-or-admin gets the whole room's
 * questions; everyone else gets only their own. The role is derived from the
 * same permission the webinar itself uses to decide who broadcasts — never
 * from anything the client sent.
 */
export async function fetchQuestions(
  eventId: string,
): Promise<WebinarQuestion[]> {
  const actor = await requireActor();

  // Even the host reads through this gate: no permission lets you read
  // questions for an event you otherwise can't see.
  const event = await gateEvent(eventId);
  if (!event) return [];

  const isHost = can(actor.caps, "events.manage");
  return isHost
    ? listQuestionsForEvent(eventId)
    : listQuestionsForAsker(eventId, actor.userId);
}

/**
 * Move a question out of the queue. Host (or admin) only.
 *
 * Gated on the global `events.manage` permission alone — deliberately no
 * per-event visibility re-check like askQuestion/fetchQuestions do. Two reasons
 * it's sufficient: `events.manage` is a staff permission and the `events read`
 * policy (0005) lets staff see every event, so a visibility check would always
 * pass; and a question row can only exist for a hosted event in the first place
 * (the insert policy in 0060 forbids any other kind), so there is no
 * non-webinar row here to wrongly touch.
 */
export async function setQuestionStatus(
  id: string,
  status: QuestionStatus,
): Promise<void> {
  const actor = await requireActor();
  if (!can(actor.caps, "events.manage")) throw new Error("Forbidden");

  const admin = createAdminClient();
  const { error } = await admin
    .from("webinar_questions")
    .update({
      status,
      resolved_by: status === "open" ? null : actor.userId,
    })
    .eq("id", id);
  if (error) throw new Error(error.message);
}
