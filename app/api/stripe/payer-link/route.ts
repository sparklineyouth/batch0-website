import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCountryFromHeaders } from "@/lib/pricing";
import { issuePayerLink, loadCheckoutApplication } from "@/lib/checkout-service";
import { applicationIdFromBody, checkoutBody, checkoutFailure, checkoutJson } from "@/lib/checkout-http";

export async function POST(req: Request) {
  try {
    let actor;
    try { actor = await requireActor(); } catch { return checkoutJson({ error: "Not signed in" }, 401); }
    const body = await checkoutBody(req);
    const rl = await checkRateLimit({ kind: "payer-link", identifier: actor.userId, limit: 10, windowSeconds: 300 });
    if (!rl.ok) return checkoutJson({ error: "Too many invitations. Try again in a few minutes." }, 429);
    const admin = createAdminClient();
    const app = await loadCheckoutApplication(admin, applicationIdFromBody(body));
    const own = app.user_id === actor.userId;
    if (!own && !can(actor.caps, "applications.review")) return checkoutJson({ error: "Application not found." }, 404);
    return checkoutJson(await issuePayerLink(admin, app, own ? getCountryFromHeaders(req.headers) : null));
  } catch (error) { return checkoutFailure(error); }
}
