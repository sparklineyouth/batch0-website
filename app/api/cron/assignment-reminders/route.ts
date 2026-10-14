import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { sendTemplated } from "@/lib/email/dispatch";
import { Templates } from "@/lib/email/templates";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { formatEastern } from "@/lib/assignments";
import {
  ASSIGNMENT_COLUMNS,
  audienceFor,
  notifyOnce,
  notifyReleased,
  type AssignmentRow,
} from "@/lib/assignments-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HOUR = 3_600_000;

/**
 * Hourly (vercel.json). Two jobs, both deduped per (student, assignment) in
 * `notifications`, so a retried or overlapping run never repeats itself:
 *
 *  1. Released: a bell for every assignment that opened in the last two days
 *     (a scheduled or course-week one opening on its own; ones that open on
 *     save were already sent by saveAssignment).
 *  2. Due soon: due within 24 hours and nothing handed in — a bell, and an
 *     email (template `assignment.due_soon`) to exactly the students whose
 *     bell was new this run.
 */
export async function GET(req: Request) {
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createAdminClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const [released, dueSoon] = await Promise.all([
    admin
      .from("course_assignments")
      .select(ASSIGNMENT_COLUMNS)
      .eq("status", "published")
      .gte("opens_at", new Date(now - 48 * HOUR).toISOString())
      .lte("opens_at", nowIso),
    admin
      .from("course_assignments")
      .select(ASSIGNMENT_COLUMNS)
      .eq("status", "published")
      .gt("due_at", nowIso)
      .lte("due_at", new Date(now + 24 * HOUR).toISOString())
      .or(`opens_at.is.null,opens_at.lte.${nowIso}`),
  ]);
  if (released.error || dueSoon.error) {
    const err = released.error ?? dueSoon.error;
    if (isMissingSchemaError(err)) return NextResponse.json({ ok: true, skipped: "assignments not set up" });
    console.error("[assignment-reminders] read failed", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  let releasedSent = 0;
  for (const a of (released.data ?? []) as AssignmentRow[]) {
    releasedSent += await notifyReleased(admin, a);
  }

  let reminded = 0;
  let emailed = 0;
  for (const a of (dueSoon.data ?? []) as AssignmentRow[]) {
    const [audience, { data: subs }] = await Promise.all([
      audienceFor(admin, a),
      admin.from("course_assignment_submissions").select("user_id").eq("assignment_id", a.id),
    ]);
    const handled = new Set((subs ?? []).map((s) => s.user_id as string));
    // Late entrants are excused from anything due before they joined.
    const due = Date.parse(a.due_at!);
    const owing = audience.filter(
      (m) => !handled.has(m.userId) && !(m.enrolledAt && Date.parse(m.enrolledAt) > due),
    );
    if (owing.length === 0) continue;
    const dueLabel = formatEastern(a.due_at);
    const link = `/dashboard/assignments/${a.id}`;
    const fresh = await notifyOnce(
      admin,
      owing.map((m) => ({
        userId: m.userId,
        type: "assignment_due_soon",
        title: `Due soon: ${a.title}`,
        body: `Due ${dueLabel}`,
        link,
        dedupeKey: `assignment_due:${a.id}`,
      })),
    );
    reminded += fresh.size;
    if (fresh.size === 0) continue;
    const { data: people } = await admin.from("profiles").select("id, email, full_name").in("id", [...fresh]);
    const url = `${env.siteUrl}${link}`;
    for (const p of people ?? []) {
      if (!p.email) continue;
      const res = await sendTemplated("assignment.due_soon", {
        to: p.email,
        toName: p.full_name,
        userId: p.id,
        vars: { assignment_title: a.title, due: dueLabel, assignment_url: url },
        fallback: () => Templates.assignmentDueSoon({ name: p.full_name, title: a.title, due: dueLabel, url }),
      });
      if (res.ok) emailed += 1;
    }
  }

  return NextResponse.json({ ok: true, released: releasedSent, reminded, emailed });
}
