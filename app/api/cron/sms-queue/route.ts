import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { drainSmsQueue } from "@/lib/sms/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The drain paces itself at ~3 messages/second to stay under what a toll-free
// number is provisioned for, so 120 messages is ~42 seconds of deliberate
// waiting before any provider latency. 60s is the ceiling; MAX_PER_DRAIN in
// lib/sms/queue.ts is what keeps a batch inside it.
export const maxDuration = 60;

/**
 * Drains the SMS outbox.
 *
 * Every five minutes, matching the email drain, and the five minutes is more
 * load-bearing here than it is there: quiet hours mean a message composed at
 * 11pm is queued for 9am recipient-local, so the queue is the normal path for
 * SMS rather than the exception. A transactional text sent during the day still
 * goes out inline through lib/sms/send.ts and does not wait for this.
 *
 * Separate from /api/cron/email-queue on purpose. One route draining both would
 * mean a Twilio outage holding email delivery open behind it, and the two have
 * genuinely different throughput ceilings — Resend takes 100 emails per HTTP
 * request, a toll-free number takes about three messages a second.
 */
export async function GET(req: Request) {
  // Fail closed when CRON_SECRET isn't configured. An open endpoint here sends
  // real texts, on demand, at our expense.
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const report = await drainSmsQueue();
  if (report.errors.length > 0) {
    console.error("[cron/sms-queue]", report.errors.join("; "));
  }
  return NextResponse.json(report);
}
