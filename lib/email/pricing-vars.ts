import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSiteConfig } from "@/lib/site-config";
import { listPriceCents, promoPriceCents } from "@/lib/promo";
import { passDiscountCentsForUser } from "@/lib/founder-pass";
import type { VariableValues } from "@/lib/email/vars";

// Live tuition merge-tags.
//
// The problem this solves: an automation freezes its merge values when the
// event fires (see enqueueEmail in lib/email/dispatch). A payment nudge queued
// the day someone is accepted and delivered three days later would quote the
// price as it was on day 0 — so an admin who changes the discount at
// /admin/pricing in between would have the sale advertised on the site but the
// OLD number sitting in every in-flight nudge. Prices in email have to be
// resolved when the mail actually leaves, against the same config the site
// reads, or they drift.
//
// So these are recomputed at send time (lib/email/dispatch's sendQueuedRow and
// the composer's immediate render) rather than trusted from the stored row.
//
// Two kinds of tag:
//   • Generic promo tags (sale_price, list_price, promo_percent, deadline) are
//     the marketing numbers — the same for everyone, straight off the current
//     site config. Safe to refresh on any email that uses them.
//   • `amount` is what a SPECIFIC applicant would pay next — regional list,
//     the current promo, then their own founder-pass discount. It is only
//     meaningful for someone who is accepted and hasn't paid, so it resolves
//     to a value only for them and is left untouched otherwise. That is what
//     keeps a payment RECEIPT (which stores the amount actually paid) from
//     being overwritten with a live quote.

const dollars = (cents: number) => `$${Math.round(cents / 100)}`;

/**
 * The recipient-independent tuition tags, from the current site config.
 *
 * `getSiteConfig()` is request-memoized, so calling this once per drained row
 * costs a single round-trip across the whole cron run. Country is not applied
 * (there is no request geography at send time), matching lib/admissions: a
 * regional applicant is quoted list and charged less at checkout.
 */
export async function currentPromoVars(): Promise<VariableValues> {
  const { derived } = await getSiteConfig();
  return {
    list_price: derived.listPriceLabel,
    sale_price: derived.priceLabel,
    promo_percent: derived.promoPercentLabel || "0",
    deadline: derived.promoDeadlineLabel || "",
  };
}

/**
 * What THIS user would pay to enroll right now, or null if there is nothing to
 * quote (no accepted-and-unpaid application). Mirrors the checkout/admissions
 * math: list → current promo → their founder-pass discount.
 *
 * Returning null for anyone who has already paid is deliberate — it is what
 * lets the caller refresh a nudge's price without clobbering a receipt's.
 */
export async function forwardTuitionLabelForUser(
  admin: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: app } = await admin
    .from("applications")
    .select("cohort:cohorts(price_cents)")
    .eq("user_id", userId)
    .eq("status", "accepted")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Supabase types the embedded to-one as either an object or a single-element
  // array depending on the inferred relationship; tolerate both.
  const cohort = Array.isArray((app as any)?.cohort)
    ? (app as any).cohort[0]
    : (app as any)?.cohort;
  if (!cohort) return null;

  const config = await getSiteConfig();
  const base = listPriceCents(cohort.price_cents ?? 13000);
  const sale = promoPriceCents(base, new Date(), config.settings.promo);
  const passDiscount = await passDiscountCentsForUser(admin, userId, sale);
  return dollars(Math.max(0, sale - passDiscount));
}

/**
 * Merge current tuition tags onto a stored variable bag, in place-safe form.
 *
 * The generic promo tags are always refreshed to the current config. `amount`
 * is refreshed only when `userId` resolves to a live forward quote — so a
 * nudge to an unpaid applicant gets today's price, and a receipt to someone
 * who has paid keeps the amount they actually paid.
 */
export async function refreshTuitionVars(
  admin: SupabaseClient,
  stored: VariableValues,
  userId: string | null,
): Promise<VariableValues> {
  const out: VariableValues = { ...stored, ...(await currentPromoVars()) };
  // The forward quote is per-user and costs a query, so only resolve it for an
  // email that actually carries an `amount` (the accepted/nudge flow stamps
  // one; a broadcast doesn't). This also means we only ever REFRESH an amount,
  // never inject one into a template that had none.
  if (userId && "amount" in out) {
    const forward = await forwardTuitionLabelForUser(admin, userId);
    if (forward !== null) out.amount = forward;
  }
  return out;
}
