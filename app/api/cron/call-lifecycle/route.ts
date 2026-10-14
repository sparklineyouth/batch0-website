import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAuditMany } from "@/lib/audit";
import { env } from "@/lib/env";
import { autoCompleteRange, shouldAutoComplete } from "@/lib/call-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every 15 minutes (vercel.json): stamp booked 1:1s `completed` once they are
 * past the hard close (end + 3 h) and nobody pressed End call. Every page
 * already derives "ended" from the clock (callPhase); this is the database
 * catching up. Only calls from the last AUTO_COMPLETE_LOOKBACK_DAYS are
 * looked at, so history is never rewritten in bulk.
 *
 * Idempotent: the update is conditional on the status it moves out of, so an
 * overlapping run, an End call or a cancel in the same second changes each
 * call once. No notifications.
 */

const BATCH = 500;

export async function GET(req: Request) {
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date();
  const { from, to } = autoCompleteRange(now);

  const { data: rows, error } = await admin
    .from("call_invites")
    .select("id, status, starts_at, duration_minutes")
    .in("status", ["invited", "accepted"])
    .gte("starts_at", from.toISOString())
    .lte("starts_at", to.toISOString())
    .order("starts_at", { ascending: true })
    .limit(BATCH);
  if (error) {
    console.error("[cron/call-lifecycle] candidate read failed", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const due = (rows ?? [])
    .filter((r: any) =>
      shouldAutoComplete(
        { status: r.status, startsAt: r.starts_at, durationMinutes: r.duration_minutes },
        now,
      ),
    )
    .map((r: any) => r.id as string);

  let completed: string[] = [];
  if (due.length > 0) {
    const { data: updated, error: updErr } = await admin
      .from("call_invites")
      .update({ status: "completed" })
      .in("id", due)
      .in("status", ["invited", "accepted"])
      .select("id");
    if (updErr) {
      console.error("[cron/call-lifecycle] update failed", updErr.message);
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
    completed = (updated ?? []).map((r: any) => r.id as string);
  }

  await logAuditMany(
    null,
    completed.map((id) => ({
      action: "call_invite.completed",
      targetType: "call_invite",
      targetId: id,
      payload: { by: "cron/call-lifecycle" },
    })),
  );

  return NextResponse.json({ considered: rows?.length ?? 0, completed: completed.length });
}
