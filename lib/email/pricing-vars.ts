import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSiteConfig } from "@/lib/site-config";
import { quoteTuition } from "@/lib/tuition-quote";
import { recoveryContext } from "@/lib/email-recovery";
import type { VariableValues } from "@/lib/email/vars";

export async function currentPromoVars(): Promise<VariableValues> {
  const { derived } = await getSiteConfig();
  return { list_price: derived.listPriceLabel, sale_price: derived.priceLabel,
    promo_percent: derived.promoPercentLabel || "0", deadline: derived.promoDeadlineLabel || "" };
}

/** A reminder's quote belongs to one application, not whichever cohort is newest.
 * Receipt amounts are never refreshed; callers must explicitly opt in for offers. */
export async function refreshTuitionVars(
  admin: SupabaseClient, stored: VariableValues, userId: string | null,
  forwardOffer = false,
): Promise<VariableValues> {
  const out = { ...stored, ...(await currentPromoVars()) };
  const { applicationId, cohortId } = recoveryContext(stored);
  if (!forwardOffer || !userId || !applicationId || !cohortId || !("amount" in out)) return out;
  const { data: app, error } = await admin.from("applications")
    .select("user_id,cohort_id,pricing_country,cohort:cohorts(price_cents)")
    .eq("id",applicationId).eq("user_id",userId).eq("cohort_id",cohortId).eq("status","accepted").maybeSingle();
  if (error) throw new Error("Cannot verify current tuition; email held for retry");
  const cohort = Array.isArray(app?.cohort) ? app.cohort[0] : app?.cohort;
  if (!app || !cohort) return out;
  const quote = await quoteTuition(admin,{userId,cohortId,rowPriceCents:cohort.price_cents,country:app.pricing_country});
  out.amount = new Intl.NumberFormat("en-US",{style:"currency",currency:quote.currency.toUpperCase()}).format(quote.amountCents/100);
  return out;
}
