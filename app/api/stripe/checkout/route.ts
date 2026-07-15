import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { checkRateLimit } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import { getCountryFromHeaders, getRegionalPrice } from "@/lib/pricing";
import {
  hasFounderPass,
  FOUNDER_PASS_TUITION_DISCOUNT_CENTS,
} from "@/lib/founder-pass";
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

  const basePriceCents = app.cohort?.price_cents ?? 13000;
  const cohortName = app.cohort?.name ?? "batch0 cohort";
  const stripePriceId: string | null = app.cohort?.stripe_price_id ?? null;

  // Regional pricing — keep the displayed marketing price in sync with
  // what we actually charge by detecting country at checkout time. When
  // a region has an override, we fall back to ad-hoc `price_data` even
  // if the cohort has a `stripe_price_id` set, because a fixed Price
  // object can't carry a different unit_amount.
  const country = getCountryFromHeaders(req.headers);
  const regional = getRegionalPrice(basePriceCents, country);

  // Founder-pass perk: $30 off tuition, applied server-side so it cannot be
  // requested — you either hold a live pass or you don't. Checked here, at
  // charge time, rather than stamped on the application: a pass redeemed
  // between acceptance and payment still counts, and a revoked one doesn't.
  const passDiscountCents = (await hasFounderPass(admin, user.id))
    ? FOUNDER_PASS_TUITION_DISCOUNT_CENTS
    : 0;
  const priceCents = Math.max(0, regional.amountCents - passDiscountCents);
  // A fixed Stripe Price can't carry the discounted amount, so any discount
  // forces the ad-hoc price_data path (same mechanics as regional pricing).
  const usePriceId =
    stripePriceId && !regional.isRegional && !passDiscountCents;

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
        usePriceId
          ? { quantity: 1, price: stripePriceId as string }
          : {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: priceCents,
                product_data: {
                  name: `batch0 — ${cohortName}`,
                  description: passDiscountCents
                    ? `One-time enrollment fee for the batch0 accelerator. Includes your $${(passDiscountCents / 100).toFixed(0)} founder pass discount.`
                    : "One-time enrollment fee for the batch0 accelerator.",
                },
              },
            },
      ],
      metadata: {
        application_id: app.id,
        user_id: user.id,
        cohort_id: app.cohort_id ?? "",
        country: country ?? "",
        regional_pricing: regional.isRegional ? "1" : "0",
        founder_pass_discount_cents: String(passDiscountCents),
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
