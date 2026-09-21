"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { stripe } from "@/lib/stripe";
import {
  findProfileByEmail,
  mintTicketToken,
  sendTicketInvite,
  ticketPayUrl,
} from "@/lib/demo-day-tickets";
import {
  normalizeTicketEmail,
  normalizeTicketText,
  parseTicketAmount,
  TICKET_NAME_MAX,
  TICKET_NOTE_MAX,
  formatTicketAmount,
} from "@/lib/demo-day-ticket-input";
import type { DemoDayTicket } from "@/lib/types";

const PATH = "/admin/demo-day/tickets";

export type SendTicketInput = {
  name: string;
  email: string;
  /** As typed — "25", "$25", "19.99". Parsed server-side. */
  amount: string;
  cohortId: string | null;
  note: string;
};

export type SendTicketResult =
  | {
      ok: true;
      id: string;
      url: string;
      /** False when the row was created but the email didn't go out. */
      emailed: boolean;
      emailReason?: string;
    }
  | { ok: false; error: string };

/**
 * Create a ticket and email its pay link.
 *
 * The row is written BEFORE the email is attempted, on purpose: a mailer
 * hiccup must not lose the ticket. The admin gets the link back either way
 * and can paste it or hit Resend, and the result says plainly whether the
 * email went out.
 */
export async function sendDemoDayTicket(
  input: SendTicketInput,
): Promise<SendTicketResult> {
  const { userId: actorId } = await assertPermission("demoday.manage");

  const email = normalizeTicketEmail(input.email);
  if (!email) return { ok: false, error: "Enter a valid email address." };
  const amountCents = parseTicketAmount(input.amount);
  if (amountCents == null) {
    return { ok: false, error: "Enter a price between $0.50 and $10,000." };
  }
  const name = normalizeTicketText(input.name, TICKET_NAME_MAX);
  const note = normalizeTicketText(input.note, TICKET_NOTE_MAX);

  const admin = createAdminClient();
  if (input.cohortId) {
    const { data: cohort } = await admin
      .from("cohorts")
      .select("id")
      .eq("id", input.cohortId)
      .maybeSingle();
    if (!cohort) return { ok: false, error: "That cohort doesn't exist." };
  }

  // Best-effort account match, so a holder who is signed in sees the event
  // on their dashboard. Re-checked again at payment time.
  const profile = await findProfileByEmail(email);

  const { data: row, error } = await admin
    .from("demo_day_tickets")
    .insert({
      token: mintTicketToken(),
      email,
      name: name ?? profile?.full_name ?? null,
      user_id: profile?.id ?? null,
      cohort_id: input.cohortId || null,
      amount_cents: amountCents,
      note,
      status: "sent",
      created_by: actorId,
    })
    .select("*")
    .single();
  if (error || !row) {
    return { ok: false, error: error?.message ?? "Could not create the ticket." };
  }
  const ticket = row as DemoDayTicket;

  const sent = await sendTicketInvite(ticket);
  if (sent.ok) {
    await admin
      .from("demo_day_tickets")
      .update({ sent_at: new Date().toISOString() })
      .eq("id", ticket.id);
  }

  await logAudit({
    action: "demo_day_ticket.sent",
    targetType: "demo_day_ticket",
    targetId: ticket.id,
    payload: {
      email,
      user_id: ticket.user_id,
      cohort_id: ticket.cohort_id,
      amount_cents: amountCents,
      emailed: sent.ok,
      email_reason: sent.ok ? null : (sent.reason ?? null),
    },
  });

  if (ticket.user_id) {
    await notify({
      userId: ticket.user_id,
      type: "demo_day_ticket_sent",
      title: `Your Demo Day ticket — ${formatTicketAmount(amountCents)}`,
      body: "The batch0 team sent you a ticket to Demo Day. Check your email for the pay link.",
      link: null,
      dedupeKey: `demo_day_ticket_sent:${ticket.id}`,
    });
  }

  revalidatePath(PATH);
  return {
    ok: true,
    id: ticket.id,
    url: ticketPayUrl(ticket.token),
    emailed: sent.ok,
    emailReason: sent.ok ? undefined : sent.reason,
  };
}

export type SimpleResult = { ok: true } | { ok: false; error: string };

/** Email the same link again. Only while it's still payable. */
export async function resendDemoDayTicket(id: string): Promise<SimpleResult> {
  await assertPermission("demoday.manage");
  const admin = createAdminClient();
  const { data } = await admin
    .from("demo_day_tickets")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  const ticket = data as DemoDayTicket | null;
  if (!ticket) return { ok: false, error: "Ticket not found." };
  if (ticket.status !== "sent") {
    return { ok: false, error: `This ticket is ${ticket.status}; nothing to resend.` };
  }

  const sent = await sendTicketInvite(ticket);
  if (!sent.ok) {
    return { ok: false, error: sent.reason ?? "The email didn't send." };
  }
  await admin
    .from("demo_day_tickets")
    .update({ sent_at: new Date().toISOString() })
    .eq("id", id);
  await logAudit({
    action: "demo_day_ticket.resent",
    targetType: "demo_day_ticket",
    targetId: id,
    payload: { email: ticket.email },
  });
  revalidatePath(PATH);
  return { ok: true };
}

/** Pull an unpaid link. The page and the checkout route both refuse it after this. */
export async function cancelDemoDayTicket(id: string): Promise<SimpleResult> {
  const { userId } = await assertPermission("demoday.manage");
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("demo_day_tickets")
    .select("status, email, user_id, amount_cents, stripe_payment_intent_id")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Ticket not found." };
  // A complimentary guest ticket (0074) is 'paid' from birth with no money
  // behind it, so cancelling — not refunding — is how it's revoked. It also
  // hands the slot back to the scholarship holder who sent it.
  const guest =
    existing.status === "paid" &&
    existing.amount_cents === 0 &&
    !existing.stripe_payment_intent_id;
  if (existing.status !== "sent" && !guest) {
    return { ok: false, error: `Only unpaid tickets can be cancelled (this one is ${existing.status}).` };
  }
  const { error } = await admin
    .from("demo_day_tickets")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancelled_by: userId,
    })
    .eq("id", id)
    .eq("status", existing.status);
  if (error) return { ok: false, error: error.message };
  await logAudit({
    action: "demo_day_ticket.cancelled",
    targetType: "demo_day_ticket",
    targetId: id,
    payload: { email: existing.email, guest },
  });
  if (guest) revalidatePath("/dashboard/scholarships");
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Refund a paid ticket in full. Marks the row optimistically; the
 * charge.refunded webhook (lib/stripe-fulfillment) mirrors the same
 * transition and is guarded, so the two can't disagree.
 */
export async function refundDemoDayTicket(
  id: string,
  reason?: string,
): Promise<SimpleResult> {
  const { userId } = await assertPermission("demoday.manage");
  const admin = createAdminClient();
  const { data } = await admin
    .from("demo_day_tickets")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  const ticket = data as DemoDayTicket | null;
  if (!ticket) return { ok: false, error: "Ticket not found." };
  if (ticket.status !== "paid") {
    return { ok: false, error: `Only paid tickets can be refunded (this one is ${ticket.status}).` };
  }
  if (!ticket.stripe_payment_intent_id) {
    return { ok: false, error: "No Stripe payment recorded for this ticket." };
  }

  let refundId: string;
  try {
    const refund = await stripe.refunds.create({
      payment_intent: ticket.stripe_payment_intent_id,
      reason: "requested_by_customer",
      metadata: reason ? { admin_reason: reason } : undefined,
    });
    refundId = refund.id;
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Stripe refused the refund." };
  }

  const { error } = await admin
    .from("demo_day_tickets")
    .update({
      status: "refunded",
      refunded_at: new Date().toISOString(),
      refunded_by: userId,
      refund_reason: reason?.trim() || null,
      stripe_refund_id: refundId,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  await logAudit({
    action: "demo_day_ticket.refunded",
    targetType: "demo_day_ticket",
    targetId: id,
    payload: {
      email: ticket.email,
      amount_cents: ticket.amount_cents,
      stripe_refund_id: refundId,
      reason: reason ?? null,
    },
  });
  if (ticket.user_id) {
    await notify({
      userId: ticket.user_id,
      type: "demo_day_ticket_refunded",
      title: "Demo Day ticket refunded",
      body: `${formatTicketAmount(ticket.amount_cents)} returned to your card.`,
      link: "/dashboard/billing",
      dedupeKey: `refund:${refundId}`,
    });
  }
  revalidatePath(PATH);
  revalidatePath("/dashboard/billing");
  return { ok: true };
}
