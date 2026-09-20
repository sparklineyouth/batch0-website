import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { resolvePayerLink } from "@/lib/checkout-service";
import { checkoutBody, checkoutFailure, checkoutJson } from "@/lib/checkout-http";

export async function POST(req: Request) {
  try {
    const body = await checkoutBody(req);
    const rl = await checkRateLimit({ kind: "payer-quote", identifier: clientIp(req), limit: 30, windowSeconds: 300 });
    if (!rl.ok) return checkoutJson({ error: "Too many requests. Try again in a few minutes." }, 429);
    const { app, quote, expiresAt } = await resolvePayerLink(createAdminClient(), body.token);
    return checkoutJson({ cohortId: app.cohort_id, cohortName: app.cohort.name, amountCents: quote.amountCents, currency: quote.currency,
      expiresAt, startDate: app.cohort.starts_on, endDate: app.cohort.ends_on,
      lateEntryUntil: app.cohort.late_entry_until ?? null, catchUpPlan: app.cohort.catch_up_plan ?? null });
  } catch (error) { return checkoutFailure(error); }
}
