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
  const { chargeId, returnTo } = body as {
    chargeId?: string;
    returnTo?: string;
  };
  if (!chargeId) {
    return NextResponse.json({ error: "Missing chargeId" }, { status: 400 });
  }

  // An allowlist, not a validated path. Both of these end up in a Stripe
  // redirect back into this origin, so anything caller-controlled here is an
  // open redirect — and "starts with a slash" is not a sufficient check
  // (`//evil.com` passes it and is a protocol-relative absolute URL). The
  // client tells us which surface it is on; the server picks from two known
  // strings and falls back to the desktop page it always used.
  const RETURN_PATHS: Record<string, string> = {
    app: "/app/billing",
    dashboard: "/dashboard/billing",
  };
  const returnBase = RETURN_PATHS[returnTo ?? ""] ?? RETURN_PATHS.dashboard;

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
      // The session id rides back so the billing screen can settle the
      // charge against Stripe on arrival. That also breaks the pay-fine
      // loop: a fine paid seconds ago is already settled by the time the
      // middleware re-checks for outstanding fines.
      //
      // `returnBase` is chosen from a fixed allowlist rather than taken from
      // the request. This value goes to Stripe and comes back as a redirect,
      // so honouring a caller-supplied URL here would be an open redirect;
      // the client sends a hint and the server decides. It exists because a
      // student who pays from the installed app was being returned to
      // /dashboard/billing — the desktop table, at min-w-[520px] on a phone —
      // which is the one place the app is not allowed to send them.
      success_url: `${origin}${returnBase}?charge_paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}${returnBase}?charge_canceled=1`,
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
