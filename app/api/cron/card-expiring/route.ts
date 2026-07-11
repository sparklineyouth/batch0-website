import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPIRY_WINDOW_DAYS = 30;

/**
 * Daily scan: for every Supabase profile that has a Stripe customer
 * with a default card expiring within EXPIRY_WINDOW_DAYS, send a
 * single "card expiring" reminder per calendar month. The cron is
 * meant to run daily — the per-month dedupe stops it from spamming.
 *
 * Why we walk profiles rather than Stripe customers: Stripe doesn't
 * expose a "list cards expiring soon" query, so we'd have to walk all
 * customers anyway. Walking from the Supabase side has the advantage
 * that we know the user's email and name from the profile, and we
 * skip anyone we already notified this month with a single column
 * lookup.
 *
 * Idempotency: a per-month bookkeeping column on profiles
 * (last_card_expiring_notified_month). Re-running the cron the same
 * day re-checks every customer but no-ops if already notified.
 */
export async function GET(req: Request) {
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createAdminClient();
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

  // Pull every profile with a Stripe customer ID. For Sparkline-sized
  // cohorts (low hundreds) this is trivial; if it grows to thousands,
  // batch by 1000 rows at a time via .range().
  const { data: profiles } = await admin
    .from("profiles")
    .select(
      "id, email, full_name, stripe_customer_id, last_card_expiring_notified_month",
    )
    .not("stripe_customer_id", "is", null);

  const today = new Date();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() + EXPIRY_WINDOW_DAYS);

  let scanned = 0;
  let notified = 0;
  let skippedNoCard = 0;
  let skippedAlreadyNotified = 0;
  let skippedNotExpiring = 0;
  let errors = 0;

  for (const p of (profiles ?? []) as any[]) {
    scanned++;
    if (!p.email || !p.stripe_customer_id) continue;
    if (p.last_card_expiring_notified_month === currentMonth) {
      skippedAlreadyNotified++;
      continue;
    }

    try {
      // Grab the customer's default payment method. `invoice_settings`
      // is the authoritative pointer to the card Stripe will charge.
      const customer = await stripe.customers.retrieve(p.stripe_customer_id);
      if (!customer || (customer as any).deleted) {
        skippedNoCard++;
        continue;
      }
      const defaultId = (customer as any).invoice_settings
        ?.default_payment_method as string | undefined;
      if (!defaultId) {
        skippedNoCard++;
        continue;
      }
      const pm = await stripe.paymentMethods.retrieve(defaultId);
      const card = (pm as any).card;
      if (!card?.exp_month || !card?.exp_year) {
        skippedNoCard++;
        continue;
      }

      // Cards expire at end-of-month, so a card flagged "08/26" is
      // valid through 2026-08-31. We compare on a date set to the
      // last day of the expiration month.
      const expiryDate = new Date(
        Date.UTC(card.exp_year, card.exp_month, 0, 23, 59, 59),
      );
      const msUntilExpiry = expiryDate.getTime() - today.getTime();
      const daysUntilExpiry = msUntilExpiry / (24 * 60 * 60 * 1000);

      // Already expired cards also go out — Stripe stops accepting
      // them but they'll never be silently fixed without a nudge.
      if (daysUntilExpiry > EXPIRY_WINDOW_DAYS) {
        skippedNotExpiring++;
        continue;
      }

      // Build the portal URL specifically for this customer so the
      // link in the email drops them straight into the "manage
      // payment methods" surface.
      const session = await stripe.billingPortal.sessions.create({
        customer: p.stripe_customer_id,
        return_url: `${env.siteUrl}/dashboard/billing`,
      });

      const t = Templates.cardExpiring({
        name: p.full_name,
        brand: String(card.brand ?? "card").toUpperCase(),
        last4: String(card.last4 ?? "????"),
        expMonth: Number(card.exp_month),
        expYear: Number(card.exp_year),
        portalUrl: session.url,
      });

      const res = await sendEmail({
        to: p.email,
        subject: t.subject,
        html: t.html,
      });

      if (res.ok) {
        notified++;
        await admin
          .from("profiles")
          .update({ last_card_expiring_notified_month: currentMonth })
          .eq("id", p.id);
      } else {
        errors++;
      }
    } catch (err: any) {
      console.error(
        "[cron card-expiring] profile",
        p.id,
        "failed:",
        err?.message ?? err,
      );
      errors++;
    }
  }

  return NextResponse.json({
    ok: true,
    month: currentMonth,
    scanned,
    notified,
    skippedAlreadyNotified,
    skippedNoCard,
    skippedNotExpiring,
    errors,
  });
}
