import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAuditMany } from "@/lib/audit";
import { env } from "@/lib/env";
import { refundScholarshipCreditFor } from "@/lib/calls";
import {
  ACCEPT_STEP_REMOVED_AT,
  autoCompleteRange,
  expiredUnderAcceptStep,
  shouldAutoComplete,
  type CallTiming,
} from "@/lib/call-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every 15 minutes (vercel.json):
 *
 *   complete  booked 1:1s past the hard close (end + 3 h) that nobody ended.
 *             Every page already derives "ended" from the clock; this is the
 *             database catching up. Only the last AUTO_COMPLETE_LOOKBACK_DAYS
 *             are looked at, so history is never rewritten in bulk.
 *   withdraw  invites that expired unanswered while calls still needed an
 *             Accept (expiredUnderAcceptStep): nobody could join those, so
 *             they are `cancelled` — never completed — and any scholarship
 *             credit goes back. A fixed backlog: once it is withdrawn this
 *             finds nothing.
 *
 * Idempotent: every update is conditional on the status it moves out of, so
 * an overlapping run, an End call or a cancel in the same second changes each
 * call once, and a credit is refunded only for rows THIS run withdrew. No
 * notifications.
 */

const BATCH = 500;

type Row = { id: string; status: string; starts_at: string; duration_minutes: number };

function timing(r: Row): CallTiming {
  return {
    status: r.status as CallTiming["status"],
    startsAt: r.starts_at,
    durationMinutes: r.duration_minutes,
  };
}

export async function GET(req: Request) {
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date();

  // ---- withdraw ------------------------------------------------------------
  const { data: legacy, error: legacyErr } = await admin
    .from("call_invites")
    .select("id, status, starts_at, duration_minutes")
    .eq("status", "invited")
    .lt("starts_at", ACCEPT_STEP_REMOVED_AT)
    .order("starts_at", { ascending: true })
    .limit(BATCH);
  if (legacyErr) {
    console.error("[cron/call-lifecycle] expired-invite read failed", legacyErr.message);
    return NextResponse.json({ error: legacyErr.message }, { status: 500 });
  }
  const expired = ((legacy ?? []) as Row[])
    .filter((r) => expiredUnderAcceptStep(timing(r)))
    .map((r) => r.id);

  let withdrawn: string[] = [];
  if (expired.length > 0) {
    const { data: updated, error: updErr } = await admin
      .from("call_invites")
      .update({ status: "cancelled" })
      .in("id", expired)
      .eq("status", "invited")
      .select("id");
    if (updErr) {
      console.error("[cron/call-lifecycle] withdraw failed", updErr.message);
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
    withdrawn = (updated ?? []).map((r: any) => r.id as string);
    for (const id of withdrawn) await refundScholarshipCreditFor(admin, id);
  }

  // ---- complete ------------------------------------------------------------
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

  const due = ((rows ?? []) as Row[])
    .filter((r) => shouldAutoComplete(timing(r), now))
    .map((r) => r.id);

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

  await logAuditMany(null, [
    ...withdrawn.map((id) => ({
      action: "call_invite.cancelled",
      targetType: "call_invite",
      targetId: id,
      payload: { by: "cron/call-lifecycle", expired_unanswered: true },
    })),
    ...completed.map((id) => ({
      action: "call_invite.completed",
      targetType: "call_invite",
      targetId: id,
      payload: { by: "cron/call-lifecycle" },
    })),
  ]);

  return NextResponse.json({
    considered: (rows?.length ?? 0) + (legacy?.length ?? 0),
    completed: completed.length,
    withdrawn: withdrawn.length,
  });
}
