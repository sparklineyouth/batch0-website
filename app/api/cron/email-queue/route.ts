import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { drainEmailQueue } from "@/lib/email/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The drain sends up to `max_sends_per_run` emails over the network. The
// default 10s would cut a large batch off mid-flight, leaving rows claimed as
// `sending` with nothing to finish them.
export const maxDuration = 60;

/**
 * Drains the email outbox and fires any scheduled automation that came due.
 *
 * Every five minutes, which is the trade: a delayed drip step lands within
 * five minutes of its scheduled moment, and a scheduled automation fires
 * within five minutes of its cron. That tolerance is why the matcher asks
 * "were you due at any point since you last ran?" rather than "are you due
 * this minute?" — see `wasDue` in lib/email/cron.ts. A schedule fires exactly
 * once per due moment regardless of when the drain lands.
 *
 * (Historical note: an earlier deploy of this file was rejected with "Hobby
 * accounts are limited to daily cron jobs" and shipped as 24 hourly entries to
 * work around it. The project is on Pro and a five-minute expression is accepted; if that error
 * ever returns, the workaround was 24 separate `0 H * * *` entries on this one
 * path, each individually legal.)
 *
 * Transactional email does not wait for this. A zero-delay step sends inline
 * at the moment the event fires; the queue only holds delayed and scheduled
 * mail. /admin/email/outbox also has a "Run queue now" button.
 */
export async function GET(req: Request) {
  // Fail closed when CRON_SECRET isn't configured. An open endpoint here
  // doesn't just burn CPU — it sends real email to real people on demand.
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const report = await drainEmailQueue();
  if (report.errors.length > 0) {
    console.error("[cron/email-queue]", report.errors.join("; "));
  }
  return NextResponse.json(report);
}
