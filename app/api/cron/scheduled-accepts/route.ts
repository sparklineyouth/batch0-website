import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyApplicationDecision } from "@/lib/application-decisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Each due acceptance sends an email + does a Discord sync over the network.
// The default 10s could cut a batch of them off mid-flight; 60 matches the
// email-queue cron for the same reason.
export const maxDuration = 60;

/**
 * Fires application acceptances that were scheduled for a future moment (see
 * migration 0062 and `scheduleAcceptance`).
 *
 * Every five minutes, which is the tolerance: an acceptance scheduled for 6am
 * lands within five minutes of 6am. The match is "due at or before now AND
 * still undecided", so an application a reviewer decided by hand in the
 * meantime — which cleared the scheduled_accept_* columns as part of that
 * decision — is simply not selected here. A parked acceptance therefore fires
 * exactly once, or not at all if it was superseded first.
 *
 * We run the SAME acceptance the Accept button runs (announceAcceptance email,
 * Discord role sync, audit row), attributed to the reviewer who scheduled it —
 * `applyApplicationDecision` clears the parked columns as part of the write, so
 * a row can't be picked up twice even if a run overlaps the next.
 */
export async function GET(req: Request) {
  // Fail closed when CRON_SECRET isn't configured — an open endpoint here
  // accepts real students and emails them on demand.
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  // Only rows still in a decidable state. A defensive guard on top of the
  // clear-on-decide contract: even if a row somehow kept its schedule after a
  // manual decision, we never re-accept something already resolved.
  const { data: due, error } = await admin
    .from("applications")
    .select("id, status, scheduled_accept_notes, scheduled_accept_by")
    .not("scheduled_accept_at", "is", null)
    .lte("scheduled_accept_at", nowIso)
    .in("status", ["submitted", "draft", "waitlisted"])
    .limit(100);
  if (error) {
    console.error("[cron/scheduled-accepts]", error.message);
    return new Response(error.message, { status: 500 });
  }

  let accepted = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const app of due ?? []) {
    const a = app as any;
    // Guard on the scheduler existing: reviewed_by / audit want a real actor.
    // A schedule with no scheduled_accept_by shouldn't be possible, but if the
    // FK was nulled (scheduler's profile deleted, on delete set null), skip
    // rather than accept anonymously.
    if (!a.scheduled_accept_by) {
      errors.push(`${a.id}: no scheduler on record, skipped`);
      continue;
    }
    try {
      await applyApplicationDecision(
        a.id,
        "accepted",
        a.scheduled_accept_notes ?? "",
        a.scheduled_accept_by,
      );
      accepted++;
    } catch (err: any) {
      failed++;
      errors.push(`${a.id}: ${err?.message ?? String(err)}`);
    }
  }

  if (errors.length > 0) {
    console.error("[cron/scheduled-accepts]", errors.join("; "));
  }
  return NextResponse.json({ due: (due ?? []).length, accepted, failed, errors });
}
