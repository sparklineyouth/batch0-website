import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { resolvePayerLink, startEnrollmentCheckout } from "@/lib/checkout-service";
import { checkoutBody, checkoutFailure, checkoutJson } from "@/lib/checkout-http";

export async function POST(req: Request) {
  try {
    const body = await checkoutBody(req);
    const rl = await checkRateLimit({ kind: "payer-checkout-ip", identifier: clientIp(req), limit: 15, windowSeconds: 300 });
    if (!rl.ok) return checkoutJson({ error: "Too many checkout attempts. Try again in a few minutes." }, 429);
    const admin = createAdminClient();
    const { app, quote } = await resolvePayerLink(admin, body.token);
    const familyLimit = await checkRateLimit({ kind: "checkout", identifier: app.user_id, limit: 5, windowSeconds: 300 });
    if (!familyLimit.ok) return checkoutJson({ error: "Too many checkout attempts. Try again in a few minutes." }, 429);
    return checkoutJson(await startEnrollmentCheckout(admin, app, quote, true));
  } catch (error) { return checkoutFailure(error); }
}
