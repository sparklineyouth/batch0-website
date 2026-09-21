import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { stripe } from "@/lib/stripe";
import { fulfillCheckoutSession } from "@/lib/stripe-fulfillment";
import { checkoutBody, checkoutFailure, checkoutJson } from "@/lib/checkout-http";

/** A parent can verify their high-entropy checkout receipt without gaining
 * access to the student's account, application answers or billing history. */
export async function POST(req: Request) {
  try {
    const body = await checkoutBody(req);
    if (typeof body.sessionId !== "string" || !/^cs_(test_|live_)?[A-Za-z0-9_]{20,220}$/.test(body.sessionId)) {
      return checkoutJson({ error: "That payment confirmation is unavailable." }, 404);
    }
    const rl = await checkRateLimit({ kind: "payer-status", identifier: clientIp(req), limit: 15, windowSeconds: 300 });
    if (!rl.ok) return checkoutJson({ error: "Please wait a moment before checking again." }, 429);
    const { data: held, error } = await createAdminClient().from("checkout_reservations")
      .select("id,user_id,application_id,cohort_id").eq("stripe_session_id", body.sessionId).maybeSingle();
    if (error) return checkoutJson({ error: "We could not confirm payment yet. Please try again." }, 503);
    if (!held) return checkoutJson({ error: "That payment confirmation is unavailable." }, 404);
    const session = await stripe.checkout.sessions.retrieve(body.sessionId);
    if (session.metadata?.checkout_reservation_id !== held.id || session.metadata?.user_id !== held.user_id ||
      session.metadata?.application_id !== held.application_id || session.metadata?.cohort_id !== held.cohort_id) {
      return checkoutJson({ error: "That payment confirmation is unavailable." }, 404);
    }
    const result = await fulfillCheckoutSession(session);
    return checkoutJson({ status: result.enrollmentBlocked ? "review" : result.state === "paid" && !result.ledgerError ? "confirmed" : "pending" });
  } catch (error) { return checkoutFailure(error); }
}
