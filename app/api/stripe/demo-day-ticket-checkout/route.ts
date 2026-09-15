import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import {
  getOrCreateStripeCustomer,
  stripeErrorMessage,
} from "@/lib/stripe-customer";
import {
  getTicketByToken,
  isTicketToken,
  ticketPayUrl,
  getDemoDayDetails,
} from "@/lib/demo-day-tickets";

/**
 * Creates a Stripe Checkout Session to pay a Demo Day ticket.
 *
 * Unlike /api/stripe/checkout and /charge-checkout there is NO signed-in
 * user here: a ticket is sent to an email address, and the person paying may
 * never have made a batch0 account. The secret token in the link is the
 * whole authorisation — it is unguessable (lib/demo-day-tickets.ts) and the
 * only thing this route accepts. Fulfillment lands in lib/stripe-fulfillment
 * via the webhook and via the ticket page settling on return.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { token } = body as { token?: string };
  if (!token || !isTicketToken(token)) {
    return NextResponse.json({ error: "Missing ticket" }, { status: 400 });
  }

  // Two limits, because there are two things to protect. Per-IP stops one
  // machine hammering Stripe's session API through us; per-token stops a
  // shared link being used to open a pile of sessions against one ticket.
  const [byIp, byToken] = await Promise.all([
    checkRateLimit({
      kind: "ticket-checkout-ip",
      identifier: clientIp(req),
      limit: 20,
      windowSeconds: 600,
    }),
    checkRateLimit({
      kind: "ticket-checkout",
      identifier: token,
      limit: 5,
      windowSeconds: 300,
    }),
  ]);
  if (!byIp.ok || !byToken.ok) {
    return NextResponse.json(
      { error: "Too many checkout attempts. Try again in a few minutes." },
      { status: 429 },
    );
  }

  const ticket = await getTicketByToken(token);
  if (!ticket) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (ticket.status !== "sent") {
    return NextResponse.json(
      {
        error:
          ticket.status === "paid"
            ? "This ticket is already paid."
            : "This ticket link is no longer active.",
      },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const details = await getDemoDayDetails(ticket.cohort_id);
  // Canonical site URL, never the attacker-controllable Origin header.
  const returnUrl = ticketPayUrl(ticket.token);

  try {
    // When the email is on a batch0 account, charge that account's Stripe
    // customer so the payment sits with the rest of their history (and the
    // billing portal). Otherwise let Checkout take the email and create the
    // customer itself.
    let customerId: string | null = null;
    if (ticket.user_id) {
      const { data: profile } = await admin
        .from("profiles")
        .select("stripe_customer_id, email, full_name")
        .eq("id", ticket.user_id)
        .maybeSingle();
      if (profile) {
        customerId = await getOrCreateStripeCustomer(
          admin,
          {
            id: ticket.user_id,
            email: profile.email ?? ticket.email,
            full_name: profile.full_name ?? ticket.name,
            stripe_customer_id: profile.stripe_customer_id ?? null,
          },
          profile.email ?? ticket.email,
        );
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      ...(customerId
        ? { customer: customerId }
        : { customer_email: ticket.email }),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: ticket.amount_cents,
            product_data: {
              name: "batch0 — Demo Day ticket",
              description: [
                "Admission to Demo Day only; not enrollment in the cohort.",
                details.cohortName ? details.cohortName : "",
                details.when ? details.when : "",
              ]
                .filter(Boolean)
                .join(" · "),
            },
          },
        },
      ],
      metadata: {
        kind: "demo_day_ticket",
        ticket_id: ticket.id,
        user_id: ticket.user_id ?? "",
        cohort_id: ticket.cohort_id ?? "",
      },
      payment_intent_data: {
        metadata: {
          kind: "demo_day_ticket",
          ticket_id: ticket.id,
          user_id: ticket.user_id ?? "",
        },
      },
      // Back to the ticket page, which settles the session against Stripe on
      // arrival — the buyer is normally back before the webhook lands.
      success_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnUrl}?canceled=1`,
    });

    await admin
      .from("demo_day_tickets")
      .update({ stripe_session_id: session.id })
      .eq("id", ticket.id);

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe ticket-checkout] failed", err);
    return NextResponse.json({ error: stripeErrorMessage(err) }, { status: 500 });
  }
}
