import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAuditMany } from "@/lib/audit";
import { env } from "@/lib/env";
import {
  autoCompleteCutoff,
  shouldAutoComplete,
} from "@/lib/call-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mark 1:1 calls `completed` once they are over.
 *
 * Nothing else ever did. `completed` has been in the status CHECK since
 * migration 0059 and no code path wrote it, so every accepted call stayed
 * `accepted` for ever — and a status that never moves is a status every
 * reader has to second-guess with the clock. The End call button now writes
 * it for calls someone ends by hand; this is the backstop for the ones that
 * end by the laptop closing, which is most of them.
 *
 * Every 15 minutes (vercel.json). "Over" is lib/call-lifecycle.ts's rule —
 * accepted, and the join window has closed — so a call is stamped at most
 * fifteen minutes after nobody could enter it any more. Nothing reads the
 * stamp in the meantime: every surface derives the same "ended" from the
 * clock, so this is the database catching up with what the pages already say,
 * not the thing that makes them say it.
 *
 * Invites nobody answered are left as `invited`. The CHECK has no value for
 * "expired" and this change adds none; the pages derive it (`expired`), and
 * rewriting a student's non-answer as some other decision would be recording
 * something that did not happen.
 *
 * Idempotent: the update is conditional on `status = 'accepted'`, so two
 * overlapping runs, or a run racing someone's End call, stamp each call once.
 * No email, no notification — the call is over, and both people knew that
 * before this ran.
 */

/** Plenty for a quarter-hour's worth of calls; the rest wait for the next run. */
const BATCH = 500;

export async function GET(req: Request) {
  // Fail closed when CRON_SECRET isn't configured, like every other cron here.
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date();

  // Prefilter in SQL on the one bound that is exact for every duration (see
  // autoCompleteCutoff), then decide per row with the shared rule rather than
  // re-deriving the window as interval arithmetic here — one copy of it.
  const { data: rows, error } = await admin
    .from("call_invites")
    .select("id, status, starts_at, duration_minutes")
    .eq("status", "accepted")
    .lte("starts_at", autoCompleteCutoff(now).toISOString())
    .order("starts_at", { ascending: true })
    .limit(BATCH);
  if (error) {
    console.error("[cron/call-lifecycle] candidate read failed", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const due = (rows ?? [])
    .filter((r: any) =>
      shouldAutoComplete(
        {
          status: r.status,
          startsAt: r.starts_at,
          durationMinutes: r.duration_minutes,
        },
        now,
      ),
    )
    .map((r: any) => r.id as string);

  if (due.length === 0) {
    return NextResponse.json({ considered: rows?.length ?? 0, completed: 0 });
  }

  const { data: updated, error: updErr } = await admin
    .from("call_invites")
    .update({ status: "completed" })
    .in("id", due)
    // Still accepted at the moment of writing — not cancelled in the last
    // second, not already ended by hand.
    .eq("status", "accepted")
    .select("id");
  if (updErr) {
    console.error("[cron/call-lifecycle] update failed", updErr.message);
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  const completed = (updated ?? []).map((r: any) => r.id as string);
  // One audit round trip for the batch, attributed to the system.
  await logAuditMany(
    null,
    completed.map((id) => ({
      action: "call_invite.completed",
      targetType: "call_invite",
      targetId: id,
      payload: { by: "cron/call-lifecycle" },
    })),
  );

  return NextResponse.json({
    considered: rows?.length ?? 0,
    completed: completed.length,
  });
}
