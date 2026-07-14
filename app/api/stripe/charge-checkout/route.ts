import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { checkRateLimit } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import {
  getOrCreateStripeCustomer,
  stripeErrorMessage,
} from "@/lib/stripe-customer";

/**
 * Creates a Stripe Checkout Session to pay an arbitrary user_charge
 * (fee or fine). Webhook handler updates the charge row to 'paid'.
 */
export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const rl = await checkRateLimit({
    kind: "charge-checkout",
    identifier: user.id,
    limit: 5,
    windowSeconds: 300,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many checkout attempts. Try again in a few minutes." },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const { chargeId } = body as { chargeId?: string };
  if (!chargeId) {
    return NextResponse.json({ error: "Missing chargeId" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: charge } = await admin
    .from("user_charges")
    .select("*")
    .eq("id", chargeId)
    .maybeSingle();
  if (!charge || charge.user_id !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (charge.status !== "pending") {
    return NextResponse.json(
      { error: `Charge is already ${charge.status}.` },
      { status: 400 },
    );
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_customer_id, email, full_name")
    .eq("id", user.id)
    .single();

  // Canonical site URL, not the attacker-controllable Origin header.
  const origin = env.siteUrl;

  try {
    const customerId = await getOrCreateStripeCustomer(
      admin,
      {
        id: user.id,
        email: profile?.email ?? null,
        full_name: profile?.full_name ?? null,
        stripe_customer_id: profile?.stripe_customer_id ?? null,
      },
      user.email,
    );

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: charge.amount_cents,
            product_data: {
              name: `batch0 — ${charge.kind === "fine" ? "Fine" : "Fee"}`,
              description: charge.description,
            },
          },
        },
      ],
      metadata: {
        kind: "user_charge",
        charge_id: charge.id,
        user_id: user.id,
      },
      payment_intent_data: {
        metadata: {
          kind: "user_charge",
          charge_id: charge.id,
          user_id: user.id,
        },
      },
      success_url: `${origin}/dashboard/billing?charge_paid=1`,
      cancel_url: `${origin}/dashboard/billing?charge_canceled=1`,
    });

    await admin
      .from("user_charges")
      .update({ stripe_session_id: session.id })
      .eq("id", charge.id);

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe charge-checkout] failed", err);
    return NextResponse.json({ error: stripeErrorMessage(err) }, { status: 500 });
  }
}
