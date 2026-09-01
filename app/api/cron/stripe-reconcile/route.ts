import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { reconcileStripe } from "@/lib/stripe-reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** How far back a scheduled run looks. Wide enough to swallow a multi-day
 *  webhook outage, narrow enough to stay cheap on a daily schedule. The
 *  admin "Sync from Stripe" button does the all-time backfill. */
const WINDOW_DAYS = 14;

/**
 * Daily safety net: replay recent Stripe transactions into the platform.
 *
 * The webhook is the primary path and reconciliation-on-return covers the
 * redirect race. This exists for what neither can catch — a deploy that
 * was down when Stripe POSTed, an event Stripe stopped retrying, or a
 * refund issued from the Stripe dashboard. Every write it makes is
 * idempotent, so on a healthy day it finds nothing to do.
 *
 * Announcements are suppressed: a payment this run discovers has already
 * been confirmed to the student on-screen at checkout time.
 */
export async function GET(req: Request) {
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const summary = await reconcileStripe({
    sinceUnix: Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86_400,
    silent: true,
  });

  if (summary.errors.length > 0) {
    console.error("[cron/stripe-reconcile] partial failures", summary.errors);
  }
  return NextResponse.json({ ok: true, windowDays: WINDOW_DAYS, ...summary });
}
