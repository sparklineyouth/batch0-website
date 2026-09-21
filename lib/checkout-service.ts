import type { SupabaseClient } from "@supabase/supabase-js";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { cohortEligibility, type AdmissionCohort } from "@/lib/cohort-eligibility";
import { quoteTuition, type TuitionQuote } from "@/lib/tuition-quote";
import { createPayerToken, hashPayerToken, isPayerToken, payerLinkExpiresAt } from "@/lib/payer-token";

export class CheckoutProblem extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
type CheckoutCohort = AdmissionCohort & { id: string; name: string; price_cents: number };
export type CheckoutApplication = {
  id: string; user_id: string; cohort_id: string; status: string; pricing_country: string | null;
  cohort: CheckoutCohort;
};
type Reservation = {
  id: string; application_id: string; user_id: string; cohort_id: string;
  quote: TuitionQuote; expires_at: string; stripe_session_id: string | null;
};
const unavailable = "This payment invitation is unavailable or expired. Ask the student for a new link.";

export async function loadCheckoutApplication(admin: SupabaseClient, applicationId: string): Promise<CheckoutApplication> {
  const { data, error } = await admin.from("applications")
    .select("id,user_id,cohort_id,status,pricing_country,cohort:cohorts(*)")
    .eq("id", applicationId).maybeSingle();
  if (error) throw new CheckoutProblem("We could not load enrollment. Please try again.", 503);
  if (!data) throw new CheckoutProblem("Application not found.", 404);
  const cohort = Array.isArray(data.cohort) ? data.cohort[0] : data.cohort;
  if (!cohort) throw new CheckoutProblem("This application needs a cohort before payment.");
  return { ...data, cohort } as CheckoutApplication;
}

export async function checkCheckoutEligibility(admin: SupabaseClient, app: CheckoutApplication): Promise<void> {
  if (app.status !== "accepted") throw new CheckoutProblem("This application is not awaiting payment.");
  const eligibility = cohortEligibility(app.cohort);
  if (!eligibility.eligible) throw new CheckoutProblem(eligibility.reason!, 409);
  const { data, error } = await admin.from("enrollments").select("id")
    .eq("cohort_id", app.cohort_id).eq("user_id", app.user_id).maybeSingle();
  if (error) throw new CheckoutProblem("We could not verify enrollment. Please try again.", 503);
  if (data) throw new CheckoutProblem("This student is already enrolled.", 409);
}

export async function applicationQuote(admin: SupabaseClient, app: CheckoutApplication, country: string | null): Promise<TuitionQuote> {
  const { data: held, error: holdError } = await admin.from("checkout_reservations")
    .select("quote").eq("application_id", app.id).eq("status", "active")
    .gt("expires_at", new Date().toISOString()).maybeSingle();
  if (holdError) throw new CheckoutProblem("Could not verify the current tuition. Please try again.", 503);
  if (held?.quote) return held.quote as TuitionQuote;
  // Existing applications use the student's region when there is no stored one.
  // An admin must never accidentally quote their own country for a student.
  const resolvedCountry = app.pricing_country ?? country;
  const quote = await quoteTuition(admin, {
    userId: app.user_id, cohortId: app.cohort_id, rowPriceCents: app.cohort.price_cents,
    country: resolvedCountry,
  });
  return { ...quote, cohortName: app.cohort.name };
}

export async function issuePayerLink(admin: SupabaseClient, app: CheckoutApplication, country: string | null) {
  await checkCheckoutEligibility(admin, app);
  const token = createPayerToken();
  const quote = await applicationQuote(admin, app, country);
  const now = new Date();
  const eligibility = cohortEligibility(app.cohort, now);
  if (!eligibility.eligible) throw new CheckoutProblem(eligibility.reason!, 409);
  const expiresAt = payerLinkExpiresAt(now, eligibility.deadline).toISOString();
  const { error } = await admin.from("payer_links").upsert({
    application_id: app.id, user_id: app.user_id, token_hash: hashPayerToken(token), quote,
    expires_at: expiresAt, created_at: now.toISOString(),
  }, { onConflict: "application_id" });
  if (error) throw new CheckoutProblem("Could not create a payment invitation. Please try again.", 503);
  return { url: `${env.siteUrl}/pay#token=${token}`, expiresAt, amountCents: quote.amountCents, currency: quote.currency };
}

export async function resolvePayerLink(admin: SupabaseClient, token: unknown) {
  if (!isPayerToken(token)) throw new CheckoutProblem(unavailable, 404);
  const { data: link, error } = await admin.from("payer_links")
    .select("id,application_id,user_id,quote,expires_at").eq("token_hash", hashPayerToken(token)).maybeSingle();
  if (error) throw new CheckoutProblem("Payment invitations are temporarily unavailable. Please try again.", 503);
  if (!link || Date.parse(link.expires_at) <= Date.now()) throw new CheckoutProblem(unavailable, 410);
  const app = await loadCheckoutApplication(admin, link.application_id);
  if (app.user_id !== link.user_id) throw new CheckoutProblem(unavailable, 404);
  await checkCheckoutEligibility(admin, app);
  // A student and parent may open payment simultaneously. Both must see and
  // pay the same still-active reservation, never two independently priced bills.
  const { data: held, error: heldError } = await admin.from("checkout_reservations")
    .select("quote").eq("application_id", app.id).eq("status", "active")
    .gt("expires_at", new Date().toISOString()).maybeSingle();
  if (heldError) throw new CheckoutProblem("Could not verify checkout. Please try again.", 503);
  return { app, quote: (held?.quote ?? link.quote) as TuitionQuote, expiresAt: link.expires_at as string };
}

export async function startEnrollmentCheckout(admin: SupabaseClient, app: CheckoutApplication, quoted: TuitionQuote, _payer: boolean): Promise<{ url: string }> {
  await checkCheckoutEligibility(admin, app);
  const { data, error } = await admin.rpc("reserve_checkout_seat", {
    p_application_id: app.id, p_user_id: app.user_id, p_quote: quoted,
  });
  if (error || !data) {
    const message = error?.message ?? "";
    const safe = /^(This cohort is full\.|This student is already enrolled\.|Enrollment has closed\.|The enrollment deadline has passed\.|This application is not ready for payment\.)/.test(message);
    throw new CheckoutProblem(safe ? message : "Could not reserve a seat. Please try again.", 409);
  }
  const reservation = data as Reservation;
  if (reservation.stripe_session_id) {
    const prior = await stripe.checkout.sessions.retrieve(reservation.stripe_session_id);
    if (prior.status === "open" && prior.url) return { url: prior.url };
    if (prior.status === "expired") {
      const { error: releaseError } = await admin.from("checkout_reservations")
        .update({ status: "released" }).eq("id", reservation.id).eq("status", "active");
      if (releaseError) throw new CheckoutProblem("Could not refresh checkout. Please try again.", 503);
      return startEnrollmentCheckout(admin, app, quoted, _payer);
    }
    throw new CheckoutProblem("This checkout is already completed or expired. Refresh the enrollment page.", 409);
  }
  const quote = reservation.quote;
  const metadata = {
    application_id: app.id, user_id: app.user_id, cohort_id: app.cohort_id,
    checkout_reservation_id: reservation.id,
    country: quote.country ?? "", regional_pricing: quote.regionalPricing ? "1" : "0",
    promo_discount_cents: String(quote.promoDiscountCents),
    founder_pass_discount_cents: String(quote.passDiscountCents),
    scholarship_discount_cents: String(quote.scholarshipDiscountCents),
    residual_waiver_cents: String(quote.residualWaiverCents ?? 0),
  };
  // No student Customer object: a parent must never see the student's saved
  // payment methods or mutate their customer record. Metadata links fulfillment.
  // Always price_data: a stale Stripe Price must not overrule the displayed quote.
  // Use a stable public confirmation for both entry points, so concurrent parent
  // and student clicks reuse identical parameters under the idempotency key.
  const session = await stripe.checkout.sessions.create({
    mode: "payment", payment_method_types: ["card"],
    line_items: [{ quantity: 1, price_data: {
      currency: quote.currency, unit_amount: quote.amountCents,
      product_data: { name: `batch0 — ${quote.cohortName ?? "cohort enrollment"}`, description: "One-time tuition for the batch0 accelerator." },
    } }],
    metadata,
    ...(quote.amountCents > 0 ? { payment_intent_data: { metadata } } : {}),
    expires_at: Math.floor(Date.parse(reservation.expires_at) / 1000),
    success_url: `${env.siteUrl}/pay#session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.siteUrl}/pay?status=canceled`,
  }, { idempotencyKey: `enrollment:${reservation.id}` });
  const { error: attachError } = await admin.rpc("attach_checkout_session", {
    p_reservation_id: reservation.id, p_session_id: session.id,
  });
  if (attachError) {
    // Keep the reservation until expiry if Stripe/DB state is uncertain. That
    // temporarily holds a seat rather than selling the same seat twice.
    throw new CheckoutProblem("Checkout could not be confirmed. Please try again.", 503);
  }
  if (!session.url) throw new CheckoutProblem("Checkout is unavailable. Please try again.", 503);
  return { url: session.url };
}
