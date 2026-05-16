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

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // 5 checkout attempts per user per 5 minutes.
  const rl = await checkRateLimit({
    kind: "checkout",
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
  const { applicationId } = body as { applicationId?: string };
  if (!applicationId) {
    return NextResponse.json({ error: "Missing applicationId" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Fetch application + cohort, ensure ownership and that it's accepted
  const { data: app } = await admin
    .from("applications")
    .select("*, cohort:cohorts(*)")
    .eq("id", applicationId)
    .maybeSingle();

  if (!app || app.user_id !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (app.status !== "accepted") {
    return NextResponse.json(
      { error: "This application isn't ready for payment yet." },
      { status: 400 },
    );
  }

  const priceCents = app.cohort?.price_cents ?? 9700;
  const cohortName = app.cohort?.name ?? "SparkLine Youth cohort";
  const stripePriceId: string | null = app.cohort?.stripe_price_id ?? null;

  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_customer_id, email, full_name")
    .eq("id", user.id)
    .single();

  // Always use the canonical site URL — never a request-controlled
  // header. The Origin header is attacker-controllable and would let a
  // forged checkout redirect land on a lookalike domain.
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
        stripePriceId
          ? { quantity: 1, price: stripePriceId }
          : {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: priceCents,
                product_data: {
                  name: `SparkLine Youth — ${cohortName}`,
                  description:
                    "One-time enrollment fee for the SparkLine Youth accelerator.",
                },
              },
            },
      ],
      metadata: {
        application_id: app.id,
        user_id: user.id,
        cohort_id: app.cohort_id ?? "",
      },
      payment_intent_data: {
        metadata: {
          application_id: app.id,
          user_id: user.id,
        },
      },
      success_url: `${origin}/dashboard/application?paid=1`,
      cancel_url: `${origin}/dashboard/application?canceled=1`,
    });

    await admin
      .from("applications")
      .update({ stripe_session_id: session.id })
      .eq("id", app.id);

    await admin.from("payments").insert({
      user_id: user.id,
      application_id: app.id,
      cohort_id: app.cohort_id,
      stripe_session_id: session.id,
      amount_cents: priceCents,
      currency: "usd",
      status: "pending",
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe checkout] failed", err);
    return NextResponse.json({ error: stripeErrorMessage(err) }, { status: 500 });
  }
}
