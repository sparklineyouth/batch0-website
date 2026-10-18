// ---------------------------------------------------------------------------
// The AI co-founder (/api/ai/chat) after a reply fails: what the student is
// told, and what sending the same question again does. Import-free, so
// `node --test` runs it.
// ---------------------------------------------------------------------------

/**
 * Is this message the student sending again the question whose reply just
 * failed? True when the newest saved row of the conversation is a user
 * message with exactly this text: its reply never got saved, because a
 * reply that saves always lands after the question it answers.
 *
 * The route saves the question before it streams, so a failed reply leaves
 * the question in ai_messages with nothing after it. Saving the resend too
 * showed the question twice for good and handed the model two identical user
 * turns in a row. On a resend the saved row is reused instead.
 *
 * `newestFirst` is the history as the route reads it: newest first, read
 * before this request saves anything.
 *
 * "Nothing after it" also describes a question whose reply is still
 * streaming, and that is not a resend: answering it again saved two replies
 * to one question. So the route asks this only while it holds the
 * conversation's reply lease (REPLY_LEASE_SECONDS). The request still
 * streaming holds it, and a second send meanwhile is refused with
 * REPLY_IN_FLIGHT before it gets here.
 */
export function isResendOfUnanswered(
  newestFirst: readonly { role: string; content: string | null }[] | null | undefined,
  message: string,
): boolean {
  const last = newestFirst?.[0];
  return !!last && last.role === "user" && (last.content ?? "") === message;
}

/**
 * What the student reads when a reply fails before it is saved. Plain text:
 * the chat bubble renders text as-is, so markdown would show its underscores.
 * After a partial reply it starts on a new paragraph and says the reply was
 * cut off; when nothing streamed it stands alone and says the reply failed.
 * "Send your message again" is safe to follow (isResendOfUnanswered).
 */
export function replyFailedNotice(streamedChars: number): string {
  return streamedChars > 0
    ? "\n\nThe reply was cut off by an error on our side and wasn't saved. Send your message again."
    : "That reply failed on our side and wasn't saved. Send your message again.";
}

/**
 * The longest one reply holds its conversation: a second message to it is
 * refused until the reply is saved or fails (the route hands the lease back
 * then), or this runs out. Five minutes is Vercel's default ceiling for a
 * function, so a lease never outlives the request holding it by much, even
 * when the request is killed before it can hand it back.
 */
export const REPLY_LEASE_SECONDS = 5 * 60;

/** The 409 for a message sent while the conversation's last reply streams. */
export const REPLY_IN_FLIGHT =
  "Your last message is still being answered. Wait for that reply, then send this one.";

/**
 * The 409 for a resend whose question was answered while it waited: another
 * send of it (another tab) streamed the reply, which this tab hasn't shown.
 */
export const ALREADY_ANSWERED =
  "That question was just answered. Reload the conversation to see the reply.";
