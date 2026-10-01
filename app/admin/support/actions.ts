"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";
import { getProfile } from "@/lib/auth";
import {
  adminTicketPath,
  announceAssigned,
  announceResolved,
  announceStaffReply,
  appendReply,
  assignTicket,
  getTicketForStaff,
  linkTicketPayment,
  requesterThreadPath,
  setTicketCategory as writeTicketCategory,
  setTicketPriority as writeTicketPriority,
  setTicketSensitive as writeTicketSensitive,
  setTicketStatus,
} from "@/lib/support";
import {
  REPLY_BODY_MAX,
  canStaffManageTicket,
  canStaffReply,
  canStaffSeeTicket,
  codePointLength,
  parseCategory,
  supportScopeFor,
  toPriority,
  toStatus,
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

export async function replyAsStaff(input: {
  ticketId: string;
  body: string;
  internal?: boolean;
}): Promise<ActionResult> {
  return runAction({ name: "replyAsStaff" }, async () => {
    const { actor, ticket } = await managedTicket(input.ticketId);
    const body = cleanReply(input.body);
    const internal = input.internal === true;
    if (!canStaffReply(ticket)) throw new Error("This request can't be replied to.");

    const res = await appendReply({
      ticket,
      body,
      // Derived from the permission assertion above, never from the client.
      author: { kind: "staff", userId: actor.userId, internal },
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
      });
    }

    await logAudit({
      action: internal ? "support_ticket.noted" : "support_ticket.replied",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference, reply_id: res.reply.id, status: res.status },
    });

    revalidateTicket(ticket);
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
