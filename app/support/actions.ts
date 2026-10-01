"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/server-guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { getProfile } from "@/lib/auth";
import type { ActionResult } from "@/lib/action-result";
import { runAction } from "@/lib/action-result";
import {
  announceNewTicket,
  announceRequesterReply,
  appendReply,
  createTicket,
  getTicketByToken,
} from "@/lib/support";
import {
  RECEIPT_REF_MAX,
  REPLY_BODY_MAX,
  TICKET_BODY_MAX,
  TICKET_BODY_MIN,
  TICKET_SUBJECT_MAX,
  canRequesterReply,
  toCategory,
} from "@/lib/support-access";

/**
 * The requester's side of the support system: file a request, follow up on one.
 *
 * Filing requires a signed-in account. That is a deliberate narrowing, and the
 * refund policy is written to match it: the form and hello@batch0.org are both
 * valid channels, so the person who pays but has no login — usually a parent —
 * still has a route that counts. (A payer capability token was considered and
 * rejected: payer_links expire 24 hours after issue and carry no parent email,
 * so a token could neither identify a requester days later nor give us an
 * address to reply to.)
 *
 * Following up requires only the ticket's token. There is no session on that
 * path by design — the emailed link has to work weeks later, in whatever
 * browser the person happens to open their mail in.
 */

const REQUESTER_LIST = "/dashboard/support";
const ADMIN_LIST = "/admin/support";

/**
 * A rate-limit key for a ticket token that isn't the token.
 *
 * checkRateLimit stores its key as a plaintext primary key in
 * public.rate_limits — a table created in migration 0005, before this project
 * adopted the revoke-the-default-grants discipline. Putting a bearer token in
 * there would mean the secret that authorizes a support thread is sitting in a
 * row, keyed for lookup. Hashing it keeps the per-token limit working (the same
 * token always maps to the same key) while leaving nothing usable behind.
 *
 * Migration 0090 also locks that table down, but this stands on its own: a
 * secret should not be written somewhere that needs a grant to be safe.
 */
function tokenRateKey(token: string): string {
  return createHash("sha256")
    .update("batch0:support-rl:v1:")
    .update(token)
    .digest("hex")
    .slice(0, 32);
}

function cleanSubject(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) throw new Error("Give your request a subject.");
  if (t.length > TICKET_SUBJECT_MAX) {
    throw new Error(`Keep the subject under ${TICKET_SUBJECT_MAX} characters.`);
  }
  return t;
}

function cleanBody(raw: string, max: number, what: string): string {
  const t = raw.trim();
  if (!t) throw new Error(`Write ${what} before sending.`);
  if (t.length > max) {
    throw new Error(`That's too long — keep it under ${max} characters.`);
  }
  return t;
}

export async function submitSupportTicket(input: {
  category: string;
  subject: string;
  body: string;
  receiptRef?: string | null;
}): Promise<ActionResult<{ reference: string; threadPath: string }>> {
  return runAction({ name: "submitSupportTicket" }, async () => {
    // requireActor, not assertPermission: every signed-in account may file a
    // request. It throws rather than redirects, which is what we want inside
    // an action — the page already sent a signed-out visitor to /login.
    const { userId } = await requireActor();
    const profile = await getProfile();
    if (!profile?.email) {
      throw new Error(
        "Your account has no email address on it, so we'd have nowhere to reply. Add one in settings first.",
      );
    }

    const category = toCategory(input.category);
    const subject = cleanSubject(input.subject);
    const body = cleanBody(input.body, TICKET_BODY_MAX, "your request");
    if (body.length < TICKET_BODY_MIN) {
      throw new Error(
        "Tell us a bit more — a few sentences about what happened is enough.",
      );
    }
    const receiptRef =
      input.receiptRef?.trim().slice(0, RECEIPT_REF_MAX) || null;

    // Two limits, because they stop different things: the per-account one
    // stops one person filling the queue, the per-IP one stops a script doing
    // it from many accounts. Both fail open (see lib/rate-limit), and
    // x-forwarded-for is client-settable, so this is a speed bump rather than
    // an abuse control — which is acceptable here precisely because filing
    // needs an account at all.
    const ip =
      (await headers()).get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const [byUser, byIp] = await Promise.all([
      checkRateLimit({
        kind: "support-ticket:user",
        identifier: userId,
        limit: 5,
        windowSeconds: 900,
      }),
      checkRateLimit({
        kind: "support-ticket:ip",
        identifier: ip,
        limit: 15,
        windowSeconds: 900,
      }),
    ]);
    if (!byUser.ok || !byIp.ok) {
      throw new Error(
        "You've opened several requests just now. Wait a few minutes, or reply on an existing one.",
      );
    }

    const ticket = await createTicket({
      userId,
      email: profile.email,
      name: profile.full_name,
      category,
      subject,
      body,
      receiptRef,
    });

    // Awaited rather than fired-and-forgotten: a serverless invocation can be
    // frozen the moment its response is returned, and a floating promise here
    // would silently drop the requester's receipt — which for a refund is the
    // one piece of evidence they have. announceNewTicket swallows its own
    // failures, so awaiting it can't fail the filing it reports on.
    await announceNewTicket(ticket);

    // The reference, not the email address — the audit log is read by more
    // people than the ticket is, and the ticket id is enough to open it.
    await logAudit({
      action: "support_ticket.created",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference, category, has_receipt_ref: !!receiptRef },
    });

    revalidatePath(REQUESTER_LIST);
    revalidatePath(ADMIN_LIST);
    return { reference: ticket.reference, threadPath: `/support/t/${ticket.token}` };
  });
}

/**
 * A follow-up from the requester, authorized by the ticket token alone.
 *
 * `isStaff: false` and `isInternal` unset are hard-coded, not derived from
 * anything the caller sent. This is the entire reason the write goes through a
 * server action on the service role instead of an RLS insert policy: the
 * browser must not be able to choose which side of the conversation a message
 * came from.
 */
export async function replyToSupportTicket(input: {
  token: string;
  body: string;
}): Promise<ActionResult> {
  return runAction({ name: "replyToSupportTicket" }, async () => {
    const body = cleanBody(input.body, REPLY_BODY_MAX, "a reply");

    const ip =
      (await headers()).get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const [byToken, byIp] = await Promise.all([
      checkRateLimit({
        kind: "support-reply:token",
        identifier: tokenRateKey(input.token),
        limit: 20,
        windowSeconds: 600,
      }),
      checkRateLimit({
        kind: "support-reply:ip",
        identifier: ip,
        limit: 40,
        windowSeconds: 600,
      }),
    ]);
    if (!byToken.ok || !byIp.ok) {
      throw new Error("Too many replies just now. Give it a minute.");
    }

    const ticket = await getTicketByToken(input.token);
    // Same answer for "no such ticket" and "bad token" — there is no second
    // credential to be wrong about, and a distinct error would confirm to a
    // prober that a token was one character off.
    if (!ticket) throw new Error("That request link isn't valid any more.");
    if (!canRequesterReply(ticket)) {
      throw new Error(
        "This request is closed and isn't accepting replies. Open a new one if you still need help.",
      );
    }

    await appendReply({
      ticket,
      body,
      isStaff: false,
      authorId: ticket.userId,
    });
    await announceRequesterReply(ticket, body);

    revalidatePath(`/support/t/${ticket.token}`);
    revalidatePath(REQUESTER_LIST);
    revalidatePath(ADMIN_LIST);
    revalidatePath(`${ADMIN_LIST}/${ticket.id}`);
  });
}
