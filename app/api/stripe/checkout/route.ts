import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
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
  const cohortName = app.cohort?.name ?? "SparkLine cohort";

  // Get / create Stripe customer
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_customer_id, email, full_name")
    .eq("id", user.id)
    .single();

  let customerId = profile?.stripe_customer_id ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: profile?.email ?? user.email ?? undefined,
      name: profile?.full_name ?? undefined,
      metadata: { supabase_user_id: user.id },
    });
    customerId = customer.id;
    await admin
      .from("profiles")
      .update({ stripe_customer_id: customerId })
      .eq("id", user.id);
  }

  const origin = req.headers.get("origin") || new URL(req.url).origin;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: priceCents,
          product_data: {
            name: `SparkLine — ${cohortName}`,
            description: "One-time enrollment fee for the SparkLine accelerator.",
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

  // Stash session id on the application for webhook correlation
  await admin
    .from("applications")
    .update({ stripe_session_id: session.id })
    .eq("id", app.id);

  // Insert pending payment row
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
}
