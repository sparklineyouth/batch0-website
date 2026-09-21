import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCountryFromHeaders } from "@/lib/pricing";
import { applicationQuote, loadCheckoutApplication, startEnrollmentCheckout } from "@/lib/checkout-service";
import { applicationIdFromBody, checkoutBody, checkoutFailure, checkoutJson } from "@/lib/checkout-http";

export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return checkoutJson({ error: "Not signed in" }, 401);
    const body = await checkoutBody(req);
    const rl = await checkRateLimit({ kind: "checkout", identifier: user.id, limit: 5, windowSeconds: 300 });
    if (!rl.ok) return checkoutJson({ error: "Too many checkout attempts. Try again in a few minutes." }, 429);
    const admin = createAdminClient();
    const app = await loadCheckoutApplication(admin, applicationIdFromBody(body));
    if (app.user_id !== user.id) return checkoutJson({ error: "Application not found." }, 404);
    const quote = await applicationQuote(admin, app, getCountryFromHeaders(req.headers));
    return checkoutJson(await startEnrollmentCheckout(admin, app, quote, false));
  } catch (error) { return checkoutFailure(error); }
}
