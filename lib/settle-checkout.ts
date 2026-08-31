import "server-only";
import type { FulfillmentResult } from "@/lib/stripe-fulfillment";

/**
 * Settle a just-completed Checkout, but only actually load Stripe when there
 * is a session to settle.
 *
 * Three dashboard pages — billing, application and enrolled — call this so a
 * charge paid seconds ago reads as paid instead of sitting in "Outstanding"
 * until the webhook catches up. All three did it through a top-level import
 * of lib/stripe-fulfillment, which pulls in the Stripe SDK and the Resend
 * mailer. That made every ordinary visit to those pages pay to parse and
 * initialise a payments stack it was never going to call: `session_id` is
 * only ever present on the one redirect back from Checkout.
 *
 * The import moves inside the branch, so the cost lands on the rare request
 * that needs it and not on the common one. Callers pass the raw search param
 * and get null when there's nothing to settle, which also removes the
 * ternary each page was repeating.
 */
export async function settleCheckoutSession(
  sessionId: string | undefined,
  userId: string,
): Promise<FulfillmentResult | null> {
  if (!sessionId) return null;
  const { syncCheckoutSession } = await import("@/lib/stripe-fulfillment");
  return await syncCheckoutSession(sessionId, userId);
}
