import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { notify } from "@/lib/notifications";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily cron: notify enrolled students of assignments due in the next
 * 24 hours that they haven't submitted.
 */
export async function GET(req: Request) {
  // Vercel Cron sends this header. In dev / manual runs, allow ?key=…
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const queryKey = url.searchParams.get("key");
  if (env.cronSecret) {
    const ok =
      auth === `Bearer ${env.cronSecret}` || queryKey === env.cronSecret;
    if (!ok) return new Response("Unauthorized", { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const { data: assignments } = await admin
    .from("assignments")
    .select("id, title, cohort_id, due_at")
    .gte("due_at", now.toISOString())
    .lte("due_at", in24h.toISOString());

  let notified = 0;
  for (const a of (assignments ?? []) as any[]) {
    const { data: enrollments } = await admin
      .from("enrollments")
      .select("user_id, profile:profiles(email, full_name)")
      .eq("cohort_id", a.cohort_id);
    const { data: subs } = await admin
      .from("assignment_submissions")
      .select("user_id, status")
      .eq("assignment_id", a.id);
    const submittedUsers = new Set(
      (subs ?? [])
        .filter((s: any) => s.status === "submitted" || s.status === "graded")
        .map((s: any) => s.user_id),
    );

    for (const e of (enrollments ?? []) as any[]) {
      if (submittedUsers.has(e.user_id)) continue;
      const profile = Array.isArray(e.profile) ? e.profile[0] : e.profile;
      const t = Templates.assignmentDueSoon({
        title: a.title,
        dueAt: a.due_at,
        assignmentId: a.id,
      });
      if (profile?.email) {
        await sendEmail({ to: profile.email, subject: t.subject, html: t.html });
      }
      await notify({
        userId: e.user_id,
        type: "assignment_due_soon",
        title: `Due soon: ${a.title}`,
        body: `Due ${new Date(a.due_at).toLocaleString()}`,
        link: `/dashboard/assignments/${a.id}`,
      });
      notified++;
    }
  }

  return NextResponse.json({ ok: true, notified });
}
