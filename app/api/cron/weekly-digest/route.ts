import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const queryKey = url.searchParams.get("key");
  if (env.cronSecret) {
    const ok =
      auth === `Bearer ${env.cronSecret}` || queryKey === env.cronSecret;
    if (!ok) return new Response("Unauthorized", { status: 401 });
  }

  const admin = createAdminClient();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { count: apps },
    { count: accepted },
    { count: paid },
    { data: payments },
    { data: admins },
  ] = await Promise.all([
    admin
      .from("applications")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since),
    admin
      .from("applications")
      .select("id", { count: "exact", head: true })
      .gte("reviewed_at", since)
      .eq("status", "accepted"),
    admin
      .from("payments")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .eq("status", "succeeded"),
    admin
      .from("payments")
      .select("amount_cents")
      .gte("created_at", since)
      .eq("status", "succeeded"),
    admin.from("profiles").select("email").eq("role", "admin"),
  ]);

  const revenue = (payments ?? []).reduce(
    (s: number, p: any) => s + (p.amount_cents ?? 0),
    0,
  );

  const t = Templates.weeklyDigest({
    apps: apps ?? 0,
    accepted: accepted ?? 0,
    paid: paid ?? 0,
    revenue,
  });
  for (const a of (admins ?? []) as any[]) {
    if (a.email) {
      await sendEmail({ to: a.email, subject: t.subject, html: t.html });
    }
  }

  return NextResponse.json({
    ok: true,
    apps: apps ?? 0,
    accepted: accepted ?? 0,
    paid: paid ?? 0,
    revenue,
  });
}
