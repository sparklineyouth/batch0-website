import { NextResponse } from "next/server";
import { CheckoutProblem } from "@/lib/checkout-service";
import { env } from "@/lib/env";
import { TuitionUnavailable } from "@/lib/tuition-quote";

export const privateCheckoutHeaders = { "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };
export function checkoutJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: privateCheckoutHeaders });
}
export async function checkoutBody(req: Request): Promise<Record<string, unknown>> {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(env.siteUrl).origin && origin !== new URL(req.url).origin) throw new CheckoutProblem("Invalid request origin.", 403);
  if (!req.headers.get("content-type")?.includes("application/json")) throw new CheckoutProblem("Expected a JSON request.");
  const raw = await req.text();
  if (raw.length > 2048) throw new CheckoutProblem("Request is too large.");
  try { const body = JSON.parse(raw); if (body && typeof body === "object" && !Array.isArray(body)) return body; } catch {}
  throw new CheckoutProblem("Invalid checkout request.");
}
export function applicationIdFromBody(body: Record<string, unknown>): string {
  if (typeof body.applicationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.applicationId)) throw new CheckoutProblem("Choose a valid application.");
  return body.applicationId;
}
export function checkoutFailure(error: unknown) {
  if (error instanceof TuitionUnavailable) return checkoutJson({ error: error.message }, 503);
  if (error instanceof CheckoutProblem) return checkoutJson({ error: error.message }, error.status);
  // Never log raw SDK errors: they can contain checkout URLs, tokens, request
  // bodies or payer details. Correlation is through the ordinary Stripe logs.
  console.error("[checkout] operation failed", { code: typeof (error as any)?.code === "string" ? (error as any).code : "unknown" });
  return checkoutJson({ error: "Could not start checkout. Please try again." }, 503);
}
