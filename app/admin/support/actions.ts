"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";
import { getProfile } from "@/lib/auth";
import { getRole } from "@/lib/roles";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import {
  adminTicketPath,
  announceAssigned,
  announceNewTicket,
  announceResolved,
  announceStaffReply,
  appendReply,
  assignTicket,
  createTicket,
  findAccountByEmail,
  getTicketForStaff,
  linkTicketPayment,
  requesterThreadPath,
  setTicketCategory as writeTicketCategory,
  setTicketPriority as writeTicketPriority,
  setTicketSensitive as writeTicketSensitive,
  setTicketStatus,
} from "@/lib/support";
import { recordAttachments, type RejectedAttachment } from "@/lib/support-attachments";
import {
  REPLY_BODY_MAX,
  TICKET_BODY_MAX,
  TICKET_BODY_MIN,
  canStaffManageTicket,
  canStaffReply,
  canStaffSeeTicket,
  checkStaffReceivedAt,
  codePointLength,
  easternLocalToIso,
  isSensitiveCategory,
  parseCategory,
  supportScopeFor,
  toOutcome,
  toPriority,
  toStaffLogChannel,
  toStatus,
  type TicketOutcome,
} from "@/lib/support-access";

/**
 * The team's side of a support ticket.
 *
 * Every mutation re-asserts `support.manage` even though the layout and the
 * middleware already gated the path on `support.view`. Two reasons, both
 * load-bearing: a server action is its own entry point and is callable by
 * anyone who can guess its id, and the section is deliberately read-gated —
 * a role holding only `support.view` can open every page here and must not be
 * able to answer in batch0's name.
 *
 * And every one goes through managedTicket(), which adds the confidentiality
 * rule: a confidential concern is "no longer exists" to anyone without
 * `support.sensitive`, here exactly as on the page.
 */

const ADMIN_LIST = "/admin/support";
const GONE = "That request no longer exists.";

/**
 * The ticket an action is about, for a support.manage holder who may see it.
 * getTicketForStaff already treats a confidential ticket as missing for a
 * scope without support.sensitive; the explicit check states the rule again
 * where the write happens, so it can't be lost in a refactor of the read.
 */
async function managedTicket(ticketId: string) {
  const actor = await assertPermission("support.manage");
  const scope = supportScopeFor(actor.userId, actor.caps);
  const ticket = await getTicketForStaff(ticketId, scope);
  if (!ticket || !canStaffManageTicket(scope, ticket)) throw new Error(GONE);
  return { actor, scope, ticket };
}

/**
 * Revalidate every surface a write to this ticket changes, staff and
 * requester. Never the emailed /support/t/<token> page: it renders per
 * request, and the token has no business in the cache layer.
 */
function revalidateTicket(ticket: { id: string; reference: string }) {
  revalidatePath(ADMIN_LIST);
  revalidatePath(adminTicketPath(ticket.id));
  revalidatePath("/dashboard/support");
  revalidatePath(requesterThreadPath(ticket.reference));
}

function cleanReply(raw: string): string {
  const t = raw.trim();
  if (!t) throw new Error("Write something before sending.");
  if (codePointLength(t) > REPLY_BODY_MAX) {
    throw new Error(`Keep the reply under ${REPLY_BODY_MAX} characters.`);
  }
  return t;
}

/**
 * How a staff message goes out: a reply (the ticket then waits on the
 * requester), a reply that also resolves it ("Send & resolve"), or an
 * internal note that only the team sees.
 */
export type StaffReplyMode = "reply" | "reply_resolve" | "note";

function toReplyMode(value: unknown): StaffReplyMode | null {
  return value === "reply" || value === "reply_resolve" || value === "note" ? value : null;
}

/**
 * Posts a message on a ticket as the team.
 *
 * `mode` arrived after `internal`, and both are accepted: an existing caller
 * that only knows `internal` keeps working, and `internal: true` is mode
 * "note". The two may not disagree — a caller that asked for privacy must
 * never end up emailing the requester, so a contradiction is refused rather
 * than settled in favour of sending.
 *
 * `attachments` is the AttachmentPicker's hidden-input value. The files are
 * recorded after the message exists (they hang off it) and before anyone is
 * told about it, so the emailed link opens onto a thread that already has
 * them. A file that doesn't make it costs the file, never the message —
 * `rejected` says which and why.
 */
export async function replyAsStaff(input: {
  ticketId: string;
  body: string;
  internal?: boolean;
  mode?: StaffReplyMode;
  /** Recorded on the ticket when the reply resolves it. Optional. */
  outcome?: string | null;
  /** JSON of the staged uploads (StagedAttachment[]), as the picker posts it. */
  attachments?: string | null;
}): Promise<ActionResult<{ rejected: RejectedAttachment[] }>> {
  return runAction({ name: "replyAsStaff" }, async () => {
    const { actor, ticket } = await managedTicket(input.ticketId);
    const body = cleanReply(input.body);
    const mode =
      input.mode === undefined ? (input.internal === true ? "note" : "reply") : toReplyMode(input.mode);
    if (!mode) throw new Error("That isn't a way to send a message.");
    if (input.internal === true && mode !== "note") {
      throw new Error("An internal note can't also go to the requester. Pick one.");
    }
    const internal = mode === "note";
    let outcome: TicketOutcome | null = null;
    if (mode === "reply_resolve" && input.outcome) {
      outcome = toOutcome(input.outcome);
      if (!outcome) throw new Error("That isn't an outcome.");
    }
    if (!canStaffReply(ticket)) throw new Error("This request can't be replied to.");

    const res = await appendReply({
      ticket,
      body,
      // Derived from the permission assertion above, never from the client.
      // Send & resolve is the reply and the resolution in one write, so the
      // status moves under the same optimistic lock as any other reply.
      author: {
        kind: "staff",
        userId: actor.userId,
        internal,
        nextStatus: mode === "reply_resolve" ? "resolved" : null,
        outcome,
      },
    });

    // The uploader is the asserted actor, and a note's files are internal
    // (recordAttachments also forces that from the reply itself). Files can
    // only have been staged under t/<this ticket>/ through the mint, which
    // applied the same support.manage + sensitive rule as managedTicket.
    const { recorded, rejected } = await recordAttachments({
      ticketId: ticket.id,
      replyId: res.reply.id,
      uploader: { kind: "staff", userId: actor.userId },
      isInternal: internal,
      staged: input.attachments,
    });

    // An internal note is not a message to the requester: no email, and the
    // audit action says which kind it was so the trail distinguishes "we
    // answered them" from "we wrote something down".
    if (!internal) {
      const profile = await getProfile();
      await announceStaffReply({
        ticket,
        replyId: res.reply.id,
        body,
        replierName: profile?.full_name?.trim() || "The batch0 team",
        // The one email says both things when a reply resolves the request,
        // so announceResolved is never called on top of it.
        resolved: res.changed && res.status === "resolved",
        // Recorded above, so the email can say the files are on the thread.
        fileCount: recorded.length,
      });
    }

    await logAudit({
      action: internal ? "support_ticket.noted" : "support_ticket.replied",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: {
        reference: ticket.reference,
        reply_id: res.reply.id,
        status: res.status,
        ...(mode === "reply_resolve" && { resolve: true, outcome }),
        ...(recorded.length > 0 && { attachments: recorded.length }),
      },
    });

    revalidateTicket(ticket);
    return { rejected };
  });
}

export async function changeTicketStatus(input: {
  ticketId: string;
  from: string;
  to: string;
}): Promise<ActionResult> {
  return runAction({ name: "changeTicketStatus" }, async () => {
    const { scope, ticket } = await managedTicket(input.ticketId);
    const from = toStatus(input.from);
    const to = toStatus(input.to);
    if (!from || !to) throw new Error("That isn't a status a request can be in.");
    if (from === to) return;

    // The `from` comparison inside setTicketStatus is an optimistic lock, not
    // decoration: another admin may have resolved this between the page render
    // and the click, and silently overwriting them is worse than saying so.
    const moved = await setTicketStatus({ ticketId: ticket.id, from, to, scope });
    if (!moved) {
      throw new Error(
        "Someone else changed this request just now — reload to see where it got to.",
      );
    }

    // Tell the requester when we finish, and only then. Reopening, closing, or
    // parking a ticket as waiting-on-them are all either internal bookkeeping
    // or already carried by a reply — an email for each would train people to
    // ignore the one that matters. `moved` is the ticket after the change, so
    // the bell is keyed on this resolution and a retried click sends one.
    if (to === "resolved") await announceResolved(moved);

    await logAudit({
      action: `support_ticket.${to}`,
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference, from, to },
    });

    revalidateTicket(ticket);
  });
}

export async function setTicketAssignee(input: {
  ticketId: string;
  assigneeId: string | null;
}): Promise<ActionResult> {
  return runAction({ name: "setTicketAssignee" }, async () => {
    const { actor, scope, ticket } = await managedTicket(input.ticketId);
    const assigneeId = input.assigneeId || null;
    if (assigneeId === ticket.assignedTo) return;

    // assignTicket refuses anyone who can't answer support requests — or, on
    // a confidential concern, can't see it.
    const updated = await assignTicket({ ticketId: ticket.id, assigneeId, scope });
    // A bell for the new owner, unless they took it themselves.
    await announceAssigned({ ticket: updated, assigneeId, actorId: actor.userId });
    await logAudit({
      action: assigneeId ? "support_ticket.assigned" : "support_ticket.unassigned",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference, assignee_id: assigneeId, previous: ticket.assignedTo },
    });
    revalidateTicket(ticket);
  });
}

/**
 * Pins the ticket to a specific charge, or (empty) unlinks it.
 *
 * linkTicketPayment only accepts a payment that belongs to the ticket's own
 * account. The check lives there and not only in the UI because the page
 * offers a list and an action takes whatever it is sent: without it, an admin
 * could be induced to attach a stranger's payment to a ticket, and the ticket
 * page would then render that person's amount and receipt as though it were
 * the requester's.
 */
export async function setTicketPayment(input: {
  ticketId: string;
  paymentId: string | null;
}): Promise<ActionResult> {
  return runAction({ name: "setTicketPayment" }, async () => {
    const { scope, ticket } = await managedTicket(input.ticketId);
    const paymentId = input.paymentId || null;
    if (paymentId === ticket.paymentId) return;

    await linkTicketPayment({ ticketId: ticket.id, paymentId, scope });
    await logAudit({
      action: paymentId ? "support_ticket.payment_linked" : "support_ticket.payment_unlinked",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference, payment_id: paymentId, previous: ticket.paymentId },
    });
    revalidateTicket(ticket);
  });
}

export async function setTicketPriority(input: {
  ticketId: string;
  priority: string;
}): Promise<ActionResult> {
  return runAction({ name: "setTicketPriority" }, async () => {
    const { scope, ticket } = await managedTicket(input.ticketId);
    const priority = toPriority(input.priority);
    if (!priority) throw new Error("That isn't a priority.");
    if (priority === ticket.priority) return;

    await writeTicketPriority({ ticketId: ticket.id, priority, scope });
    await logAudit({
      action: "support_ticket.priority_changed",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference, from: ticket.priority, to: priority },
    });
    revalidateTicket(ticket);
  });
}

/**
 * Recategorises a ticket. Moving one INTO "Report a concern" also makes it
 * confidential (lib/support.ts), so someone without support.sensitive loses
 * sight of it the moment they do — `hidden` tells the page to go back to the
 * queue rather than reload into a 404.
 */
export async function setTicketCategory(input: {
  ticketId: string;
  category: string;
}): Promise<ActionResult<{ hidden: boolean }>> {
  return runAction({ name: "setTicketCategory" }, async () => {
    const { scope, ticket } = await managedTicket(input.ticketId);
    const category = parseCategory(input.category);
    if (!category) throw new Error("That isn't a category.");
    if (category === ticket.category) return { hidden: false };

    const updated = await writeTicketCategory({ ticketId: ticket.id, category, scope });
    await logAudit({
      action: "support_ticket.category_changed",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference, from: ticket.category, to: category },
    });
    revalidateTicket(ticket);
    return { hidden: !canStaffSeeTicket(scope, updated) };
  });
}

/** Marks or unmarks a request confidential. Needs support.sensitive as well as support.manage. */
export async function setTicketSensitive(input: {
  ticketId: string;
  sensitive: boolean;
}): Promise<ActionResult> {
  return runAction({ name: "setTicketSensitive" }, async () => {
    const { scope, ticket } = await managedTicket(input.ticketId);
    if (!scope.canSeeSensitive) {
      throw new Error("Only staff who can see confidential concerns can change this.");
    }
    const sensitive = input.sensitive === true;
    if (sensitive === ticket.sensitive) return;

    await writeTicketSensitive({ ticketId: ticket.id, sensitive, scope });
    await logAudit({
      action: sensitive ? "support_ticket.marked_confidential" : "support_ticket.unmarked_confidential",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference },
    });
    revalidateTicket(ticket);
  });
}

// ---------------------------------------------------------------------------
// Logging a request on someone's behalf (/admin/support/new)
// ---------------------------------------------------------------------------

const CONFIDENTIAL_LOG_REFUSAL =
  "Only staff who can see confidential concerns can log one. Hand it to someone who can — filed under another kind, the whole team could read it.";

/** Who an email address belongs to, as the "log a request" form shows it. */
export type RequesterLookup = {
  account: { name: string | null; email: string; roleLabel: string } | null;
};

/**
 * The person lookup behind /admin/support/new: does an account use this
 * address? Only so the form can say who the request will land on —
 * createTicket matches the address again when it files, so nothing here is
 * trusted later. Same permission as filing, because it answers "is this
 * person on batch0?" for any address typed into it.
 */
export async function lookUpRequester(input: {
  email: string;
}): Promise<ActionResult<RequesterLookup>> {
  return runAction({ name: "lookUpRequester" }, async () => {
    await assertPermission("support.manage");
    const email = String(input.email ?? "").trim();
    if (isPlaceholderEmail(email)) {
      throw new Error("That's a placeholder address with no inbox behind it. Enter the one the request came from.");
    }
    const account = await findAccountByEmail(email);
    if (!account) return { account: null };
    const role = await getRole(account.role);
    return {
      account: {
        name: account.fullName?.trim() || null,
        email: account.email,
        roleLabel: role?.label ?? account.role,
      },
    };
  });
}

/** What became of the requester's confirmation, carried to the ticket page. */
type LoggedConfirmation = "sent" | "unsent" | "off";

/**
 * Files a request that reached the team some other way — an email to the
 * inbox, a phone call — so it is worked, and counted, like one filed on the
 * site.
 *
 * `receivedAt` is the form's datetime-local value, read as New York wall
 * time whatever zone the staff member's laptop is in, because it becomes the
 * request's refund clock: the 48 hours stop when the email arrived, not when
 * someone got round to logging it. Not in the future, not past 90 days
 * (checkStaffReceivedAt); createTicket checks it again.
 *
 * A confidential concern can only be logged by someone who could open it
 * afterwards. Without support.sensitive the new ticket would vanish from the
 * person who just filed it — and the tempting workaround, filing it under
 * another kind, is exactly what must not happen.
 *
 * On success this redirects to the new ticket, so the result type only ever
 * carries a refusal back to the form.
 */
export async function logSupportRequest(input: {
  email: string;
  name?: string | null;
  channel: string;
  receivedAt: string;
  category: string;
  priority?: string | null;
  subject?: string | null;
  body: string;
  /** "Send them a confirmation with their thread link". Defaults to on. */
  sendConfirmation?: boolean;
}): Promise<ActionResult> {
  const res = await runAction({ name: "logSupportRequest" }, async () => {
    const actor = await assertPermission("support.manage");
    const scope = supportScopeFor(actor.userId, actor.caps);

    const category = parseCategory(input.category);
    if (!category) throw new Error("Choose what kind of request it is.");
    if (isSensitiveCategory(category) && !scope.canSeeSensitive) {
      throw new Error(CONFIDENTIAL_LOG_REFUSAL);
    }
    const channel = toStaffLogChannel(input.channel);
    if (!channel) throw new Error("Choose how the request reached us.");
    const receivedAt = easternLocalToIso(String(input.receivedAt ?? ""));
    const timeProblem = checkStaffReceivedAt(receivedAt);
    if (timeProblem || !receivedAt) {
      throw new Error(timeProblem ?? "Enter the date and time the request arrived.");
    }
    const priority = input.priority ? toPriority(input.priority) : null;
    if (input.priority && !priority) throw new Error("That isn't a priority.");
    // createTicket enforces the same bounds, in the requester's words; these
    // are the team's.
    const body = String(input.body ?? "").trim();
    if (codePointLength(body) < TICKET_BODY_MIN) {
      throw new Error(`Paste the request itself — at least ${TICKET_BODY_MIN} characters.`);
    }
    if (codePointLength(body) > TICKET_BODY_MAX) {
      throw new Error(`Keep it under ${TICKET_BODY_MAX} characters — paste the part that matters.`);
    }

    // Matched to an account by the address when one exists (the person then
    // sees it on their dashboard and in the app); otherwise it lives on the
    // address alone and they follow it through the emailed link.
    const ticket = await createTicket({
      filedBy: "staff",
      staffId: actor.userId,
      requesterEmail: String(input.email ?? ""),
      requesterName: String(input.name ?? "").trim() || null,
      channel,
      receivedAt,
      category,
      priority,
      subject: String(input.subject ?? "").trim() || null,
      body,
    });

    // Awaited, like the self-filed path: a serverless invocation can freeze
    // once it responds, and the receipt is the requester's record of when
    // the clock stopped. announceNewTicket never throws, and it reports
    // whether the receipt really went — the ticket page says only that.
    const sendConfirmation = input.sendConfirmation !== false;
    const { requesterEmailed } = await announceNewTicket(ticket, {
      notifyRequester: sendConfirmation,
    });
    const confirmation: LoggedConfirmation = !sendConfirmation
      ? "off"
      : requesterEmailed
        ? "sent"
        : "unsent";

    // The reference, not the address — the audit log is read by more people
    // than the ticket is. received_at is the point of a logged request, so it
    // goes in the trail exactly as stored.
    await logAudit({
      action: "support_ticket.logged",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: {
        reference: ticket.reference,
        category,
        priority: ticket.priority,
        channel,
        received_at: ticket.receivedAt,
        on_account: !!ticket.userId,
        confirmation,
      },
    });

    revalidateTicket(ticket);
    return { id: ticket.id, confirmation };
  });
  if (!res.ok) return res;
  // The redirect is the success response, so it comes after the work rather
  // than inside it (submitApplicationAction's shape). The flag only picks
  // which sentence the ticket page shows about the confirmation email.
  redirect(`${adminTicketPath(res.data!.id)}?logged=${res.data!.confirmation}`);
}
