"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/server-guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { getProfile } from "@/lib/auth";
import { env } from "@/lib/env";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { runAction, type ActionResult } from "@/lib/action-result";
import {
  adminTicketPath,
  announceNewTicket,
  announceRequesterReply,
  appendReply,
  createTicket,
  getSupportTicketByToken,
  getTicketForOwner,
  markTicketSolvedByRequester,
  requesterThreadPath,
} from "@/lib/support";
import {
  REPLY_BODY_MAX,
  TICKET_BODY_MAX,
  TICKET_BODY_MIN,
  TICKET_SUBJECT_MAX,
  canRequesterMarkSolved,
  canRequesterReply,
  codePointLength,
  parseCategory,
  toSurface,
  wantsReceiptRef,
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
 * Following up works two ways. Signed in, the session is the credential and
 * the reference names the request (/dashboard/support/<reference>). From the
 * emailed link, the ticket's token is the only credential — there is no
 * session on that path by design, because the link has to work weeks later,
 * in whatever browser the person happens to open their mail in.
 *
 * Every action takes (previous state, FormData) and returns the flat result
 * below, so a form can hold it in useActionState or call it directly.
 */

const REQUESTER_LIST = "/dashboard/support";
const ADMIN_LIST = "/admin/support";

const CLOSED =
  "This request is closed and isn't accepting replies. Open a new one if you still need help.";

type Refusal = { ok: false; error: string; fieldErrors?: Record<string, string> };

export type SubmitSupportRequestResult =
  | {
      ok: true;
      reference: string;
      /** The recorded arrival time (ISO) — what the refund window is measured against. */
      receivedAt: string;
      /** The signed-in thread, never the emailed token link. */
      threadPath: string;
      /** The receipt email actually went out. Say "we emailed you" only when true. */
      emailed: boolean;
    }
  | Refusal;

export type SupportFollowUpResult = { ok: true } | Refusal;

/**
 * runAction's logging and redirect handling, with its result flattened into
 * the shape above: a thrown Error becomes `{ ok: false, error }`, and a
 * Refusal returned on purpose (per-field validation) passes through as-is.
 */
async function settle<T extends { ok: boolean }>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | Refusal> {
  const res: ActionResult<T> = await runAction({ name }, fn);
  if (!res.ok) return { ok: false, error: res.error };
  return res.data ?? { ok: false, error: "Something went wrong. Try again." };
}

function field(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

/** One refusal carrying every field problem, led by the first. */
function refuse(fieldErrors: Record<string, string>): Refusal {
  return { ok: false, error: Object.values(fieldErrors)[0], fieldErrors };
}

/** What's wrong with a follow-up's body, if anything. Lengths as Postgres counts them. */
function replyProblem(body: string): string | null {
  if (!body) return "Write a reply before sending.";
  if (codePointLength(body) > REPLY_BODY_MAX) {
    return `That's too long — keep it under ${REPLY_BODY_MAX} characters.`;
  }
  return null;
}

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

async function clientIp(): Promise<string> {
  return (await headers()).get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

/**
 * Every page a requester's write changes. Deliberately not the emailed
 * /support/t/<token> page: it renders per request anyway, and handing the
 * bearer token to the cache layer as a path to invalidate would be one more
 * place the secret is written down.
 */
function revalidateTicket(ticket: { id: string; reference: string }) {
  revalidatePath(REQUESTER_LIST);
  revalidatePath(requesterThreadPath(ticket.reference));
  revalidatePath(ADMIN_LIST);
  revalidatePath(adminTicketPath(ticket.id));
}

/**
 * Files a request (fields: category, subject, body, receipt_ref, payment_id,
 * surface, and the prefill context page / source / digest).
 */
export async function submitSupportRequest(
  _prev: unknown,
  formData: FormData,
): Promise<SubmitSupportRequestResult> {
  return settle("submitSupportRequest", async (): Promise<SubmitSupportRequestResult> => {
    // requireActor, not assertPermission: every signed-in account may file a
    // request. It throws rather than redirects, which is what we want inside
    // an action — the page already sent a signed-out visitor to /login.
    const { userId } = await requireActor();
    const profile = await getProfile();
    const email = profile?.email?.trim() ?? "";
    // Accounts an admin created without an email carry a placeholder on the
    // reserved .invalid TLD. A request we can never answer is worse than
    // none, so say where to write instead — email counts the same.
    if (!profile || !email || isPlaceholderEmail(email) || /\.invalid$/i.test(email)) {
      return {
        ok: false,
        error: `Your account doesn't have an email address we can reply to. Email ${env.contactEmail} instead — it reaches the same people and counts the same.`,
      };
    }

    // Strict: a missing or unknown category is a question back to the person,
    // never a silent "Something else" — a refund filed there would sit in the
    // wrong pile with its 48-hour clock running.
    const category = parseCategory(formData.get("category"));
    const subject = field(formData, "subject").replace(/\s+/g, " ").trim();
    const body = field(formData, "body").trim();
    const problems: Record<string, string> = {};
    if (!category) problems.category = "Choose what this is about.";
    if (codePointLength(subject) > TICKET_SUBJECT_MAX) {
      problems.subject = `Keep the subject under ${TICKET_SUBJECT_MAX} characters.`;
    }
    const length = codePointLength(body);
    if (length < TICKET_BODY_MIN) {
      problems.body = "Tell us a bit more — a few sentences about what happened is enough.";
    } else if (length > TICKET_BODY_MAX) {
      problems.body = `That's too long — keep it under ${TICKET_BODY_MAX} characters.`;
    }
    if (!category || Object.keys(problems).length > 0) return refuse(problems);

    // Two limits, because they stop different things: the per-account one
    // stops one person filling the queue, the per-IP one stops a script doing
    // it from many accounts. Both fail open (see lib/rate-limit), and
    // x-forwarded-for is client-settable, so this is a speed bump rather than
    // an abuse control — which is acceptable here precisely because filing
    // needs an account at all.
    const [byUser, byIp] = await Promise.all([
      checkRateLimit({
        kind: "support-ticket:user",
        identifier: userId,
        limit: 5,
        windowSeconds: 900,
      }),
      checkRateLimit({
        kind: "support-ticket:ip",
        identifier: await clientIp(),
        limit: 15,
        windowSeconds: 900,
      }),
    ]);
    if (!byUser.ok || !byIp.ok) {
      throw new Error(
        "You've opened several requests just now. Wait a few minutes, or reply on an existing one.",
      );
    }

    const surface = toSurface(formData.get("surface"));
    const ticket = await createTicket({
      filedBy: "requester",
      userId,
      email,
      name: profile.full_name,
      category,
      // Blank is fine: the data layer files it under the body's first line.
      subject: subject || null,
      body,
      receiptRef: wantsReceiptRef(category) ? field(formData, "receipt_ref").trim() || null : null,
      paymentId: field(formData, "payment_id").trim() || null,
      surface,
      // Raw on purpose: createTicket keeps only what sanitizeContext lets
      // through (a pathname, never a query or a secret URL; a short source;
      // an error digest; a clamped user agent).
      context: {
        page: formData.get("page"),
        source: formData.get("source"),
        digest: formData.get("digest"),
        userAgent: (await headers()).get("user-agent"),
      },
    });

    // Awaited rather than fired-and-forgotten: a serverless invocation can be
    // frozen the moment its response is returned, and a floating promise here
    // would silently drop the requester's receipt — which for a refund is the
    // one piece of evidence they have. announceNewTicket swallows its own
    // failures, so awaiting it can't fail the filing it reports on; it says
    // whether the receipt actually went, and the confirmation says only that.
    const { requesterEmailed } = await announceNewTicket(ticket);

    // The reference, not the email address — the audit log is read by more
    // people than the ticket is, and the ticket id is enough to open it.
    await logAudit({
      action: "support_ticket.created",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: {
        reference: ticket.reference,
        category,
        channel: ticket.channel,
        has_receipt_ref: !!ticket.receiptRef,
      },
    });

    revalidatePath(REQUESTER_LIST);
    revalidatePath(ADMIN_LIST);
    return {
      ok: true,
      reference: ticket.reference,
      receivedAt: ticket.receivedAt,
      threadPath: requesterThreadPath(ticket.reference, surface),
      emailed: requesterEmailed,
    };
  });
}

/**
 * A follow-up from the signed-in owner (fields: reference, body). The session
 * is the credential; the reference only names the request, and a reference
 * that isn't theirs is the same "not found" as one that doesn't exist.
 */
export async function replyToOwnTicket(
  _prev: unknown,
  formData: FormData,
): Promise<SupportFollowUpResult> {
  return settle("replyToOwnTicket", async (): Promise<SupportFollowUpResult> => {
    const { userId } = await requireActor();
    const body = field(formData, "body").trim();
    const problem = replyProblem(body);
    if (problem) return refuse({ body: problem });

    const limit = await checkRateLimit({
      kind: "support-reply:user",
      identifier: userId,
      limit: 20,
      windowSeconds: 600,
    });
    if (!limit.ok) throw new Error("Too many replies just now. Give it a minute.");

    const ticket = await getTicketForOwner(userId, field(formData, "reference"));
    if (!ticket) throw new Error("We couldn't find that request.");
    if (!canRequesterReply(ticket)) throw new Error(CLOSED);

    // The author is derived from the session, never from anything the form
    // sent: the browser must not be able to choose which side of the
    // conversation a message came from.
    const { reply } = await appendReply({
      ticket,
      body,
      author: { kind: "requester", userId, via: "session" },
    });
    await announceRequesterReply(ticket, { id: reply.id, body });

    revalidateTicket(ticket);
    return { ok: true };
  });
}

/**
 * The owner's "This is solved" (fields: reference). Conditional on the status
 * the data layer reads, so it can't overwrite a reply the team sent a moment
 * ago with a stale "resolved". No email — they did it themselves.
 */
export async function markOwnTicketSolved(
  _prev: unknown,
  formData: FormData,
): Promise<SupportFollowUpResult> {
  return settle("markOwnTicketSolved", async (): Promise<SupportFollowUpResult> => {
    const { userId } = await requireActor();
    const ticket = await getTicketForOwner(userId, field(formData, "reference"));
    if (!ticket) throw new Error("We couldn't find that request.");
    // Already resolved is what they asked for; a double click lands here.
    if (ticket.status === "resolved") return { ok: true };
    if (!canRequesterMarkSolved(ticket)) throw new Error(CLOSED);

    const solved = await markTicketSolvedByRequester(ticket);
    if (!solved) {
      throw new Error("This request changed just now — reload to see where it got to.");
    }
    await logAudit({
      action: "support_ticket.resolved_by_requester",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference, from: ticket.status, to: "resolved" },
    });

    revalidateTicket(ticket);
    return { ok: true };
  });
}

/**
 * A follow-up authorized by the ticket token alone (fields: token, body) — the
 * emailed link's thread.
 *
 * The author kind is hard-coded, not derived from anything the caller sent.
 * This is the entire reason the write goes through a server action on the
 * service role instead of an RLS insert policy: the browser must not be able
 * to choose which side of the conversation a message came from.
 */
export async function replyToSupportTicket(
  _prev: unknown,
  formData: FormData,
): Promise<SupportFollowUpResult> {
  return settle("replyToSupportTicket", async (): Promise<SupportFollowUpResult> => {
    const token = field(formData, "token");
    const body = field(formData, "body").trim();
    const problem = replyProblem(body);
    if (problem) return refuse({ body: problem });

    const [byToken, byIp] = await Promise.all([
      checkRateLimit({
        kind: "support-reply:token",
        identifier: tokenRateKey(token),
        limit: 20,
        windowSeconds: 600,
      }),
      checkRateLimit({
        kind: "support-reply:ip",
        identifier: await clientIp(),
        limit: 40,
        windowSeconds: 600,
      }),
    ]);
    if (!byToken.ok || !byIp.ok) {
      throw new Error("Too many replies just now. Give it a minute.");
    }

    const ticket = await getSupportTicketByToken(token);
    // Same answer for "no such ticket" and "bad token" — there is no second
    // credential to be wrong about, and a distinct error would confirm to a
    // prober that a token was one character off.
    if (!ticket) throw new Error("That request link isn't valid any more.");
    if (!canRequesterReply(ticket)) throw new Error(CLOSED);

    const { reply } = await appendReply({
      ticket,
      body,
      author: { kind: "requester", userId: ticket.userId, via: "token" },
    });
    await announceRequesterReply(ticket, { id: reply.id, body });

    revalidateTicket(ticket);
    return { ok: true };
  });
}
