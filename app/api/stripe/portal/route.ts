import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { stripeErrorMessage } from "@/lib/stripe-customer";

/**
 * Redirect signed-in users to the Stripe customer portal so they can
 * download receipts, update their card, etc.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_customer_id, email")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.stripe_customer_id) {
    return NextResponse.json(
      { error: "No Stripe customer yet — make a payment first." },
      { status: 400 },
    );
  }

  const origin = req.headers.get("origin") || env.siteUrl;
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${origin}/dashboard/billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err: unknown) {
    // Stale customer ID (e.g. test-mode ID in live mode). Clear it so
    // the next payment creates a fresh one, and tell the user to retry.
    const code = (err as { code?: string }).code;
    if (code === "resource_missing") {
      await admin
        .from("profiles")
        .update({ stripe_customer_id: null })
        .eq("id", user.id);
      return NextResponse.json(
        {
          error:
            "Your Stripe customer record was reset. Make a new payment to re-link your account, then the portal will be available again.",
        },
        { status: 400 },
      );
    }
    console.error("[stripe portal] failed", err);
    return NextResponse.json({ error: stripeErrorMessage(err) }, { status: 500 });
  }
}
