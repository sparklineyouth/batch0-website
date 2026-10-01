"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";
import { getProfile } from "@/lib/auth";
import {
  announceResolved,
  announceStaffReply,
  appendReply,
  assignTicket,
  getTicketForStaff,
  linkTicketPayment,
  setTicketStatus,
} from "@/lib/support";
import {
  REPLY_BODY_MAX,
  TICKET_STATUSES,
  canStaffReply,
  type TicketStatus,
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
 */

const ADMIN_LIST = "/admin/support";

/** Revalidate every surface a write to this ticket changes, staff and requester. */
function revalidateTicket(id: string, token: string) {
  revalidatePath(ADMIN_LIST);
  revalidatePath(`${ADMIN_LIST}/${id}`);
  revalidatePath(`/support/t/${token}`);
  revalidatePath("/dashboard/support");
}

function cleanReply(raw: string): string {
  const t = raw.trim();
  if (!t) throw new Error("Write something before sending.");
  if (t.length > REPLY_BODY_MAX) {
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
    const { userId } = await assertPermission("support.manage");
    const body = cleanReply(input.body);
    const internal = input.internal === true;

    const ticket = await getTicketForStaff(input.ticketId);
    if (!ticket) throw new Error("That request no longer exists.");
    if (!canStaffReply(ticket)) throw new Error("This request can't be replied to.");

    const reply = await appendReply({
      ticket,
      body,
      // Derived from the permission assertion above, never from the client.
      isStaff: true,
      isInternal: internal,
      authorId: userId,
    });

    // An internal note is not a message to the requester: no email, and the
    // audit action says which kind it was so the trail distinguishes "we
    // answered them" from "we wrote something down".
    if (!internal) {
      const profile = await getProfile();
      await announceStaffReply({
        ticket,
        replyId: reply.id,
        body,
        replierName: profile?.full_name?.trim() || "The batch0 team",
      });
    }

    await logAudit({
      action: internal ? "support_ticket.noted" : "support_ticket.replied",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference, reply_id: reply.id },
    });

    revalidateTicket(ticket.id, ticket.token);
  });
}

export async function changeTicketStatus(input: {
  ticketId: string;
  from: string;
  to: string;
}): Promise<ActionResult> {
  return runAction({ name: "changeTicketStatus" }, async () => {
    await assertPermission("support.manage");

    const from = input.from as TicketStatus;
    const to = input.to as TicketStatus;
    if (!(TICKET_STATUSES as readonly string[]).includes(to)) {
      throw new Error("That isn't a status a request can be in.");
    }
    if (from === to) return;

    const ticket = await getTicketForStaff(input.ticketId);
    if (!ticket) throw new Error("That request no longer exists.");

    // The `from` comparison inside setTicketStatus is an optimistic lock, not
    // decoration: another admin may have resolved this between the page render
    // and the click, and silently overwriting them is worse than saying so.
    const moved = await setTicketStatus({ ticketId: ticket.id, from, to });
    if (!moved) {
      throw new Error(
        "Someone else changed this request just now — reload to see where it got to.",
      );
    }

    // Tell the requester when we finish, and only then. Reopening, closing, or
    // parking a ticket as waiting-on-them are all either internal bookkeeping
    // or already carried by a reply — an email for each would train people to
    // ignore the one that matters.
    if (to === "resolved") await announceResolved(ticket);

    await logAudit({
      action: `support_ticket.${to}`,
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference, from, to },
    });

    revalidateTicket(ticket.id, ticket.token);
  });
}

export async function setTicketAssignee(input: {
  ticketId: string;
  assigneeId: string | null;
}): Promise<ActionResult> {
  return runAction({ name: "setTicketAssignee" }, async () => {
    await assertPermission("support.manage");
    const ticket = await getTicketForStaff(input.ticketId);
    if (!ticket) throw new Error("That request no longer exists.");

    await assignTicket(ticket.id, input.assigneeId || null);
    await logAudit({
      action: input.assigneeId ? "support_ticket.assigned" : "support_ticket.unassigned",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference, assignee_id: input.assigneeId ?? null },
    });
    revalidateTicket(ticket.id, ticket.token);
  });
}

/**
 * Pins the ticket to a specific charge.
 *
 * Only accepts a payment that belongs to the ticket's own account. The check
 * is here and not only in the UI because the page offers a list and an action
 * takes whatever it is sent: without it, an admin could be induced to attach a
 * stranger's payment to a ticket, and the ticket page would then render that
 * person's amount and receipt as though it were the requester's.
 */
export async function setTicketPayment(input: {
  ticketId: string;
  paymentId: string | null;
}): Promise<ActionResult> {
  return runAction({ name: "setTicketPayment" }, async () => {
    await assertPermission("support.manage");
    const ticket = await getTicketForStaff(input.ticketId);
    if (!ticket) throw new Error("That request no longer exists.");

    if (input.paymentId) {
      const admin = createAdminClient();
      const { data } = await admin
        .from("payments")
        .select("id, user_id")
        .eq("id", input.paymentId)
        .maybeSingle();
      if (!data) throw new Error("That payment doesn't exist.");
      if (!ticket.userId || (data as any).user_id !== ticket.userId) {
        throw new Error(
          "That payment belongs to a different account, so it can't be attached to this request.",
        );
      }
    }

    await linkTicketPayment(ticket.id, input.paymentId || null);
    await logAudit({
      action: "support_ticket.payment_linked",
      targetType: "support_ticket",
      targetId: ticket.id,
      payload: { reference: ticket.reference, payment_id: input.paymentId ?? null },
    });
    revalidateTicket(ticket.id, ticket.token);
  });
}
