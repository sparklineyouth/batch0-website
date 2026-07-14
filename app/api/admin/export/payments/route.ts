import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import { toCsv, csvResponse } from "@/lib/csv";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await getProfile();
  if (actor?.role !== "admin") {
    return new Response("Forbidden", { status: 403 });
  }
  const admin = createAdminClient();
  const { data } = await admin
    .from("payments")
    .select(
      "id, status, amount_cents, currency, stripe_payment_intent_id, stripe_session_id, created_at, profile:profiles!payments_user_id_fkey(email, full_name), cohort:cohorts(name)",
    )
    .order("created_at", { ascending: false });

  const rows = (data ?? []).map((p: any) => {
    const profile = Array.isArray(p.profile) ? p.profile[0] : p.profile;
    const cohort = Array.isArray(p.cohort) ? p.cohort[0] : p.cohort;
    return [
      p.id,
      p.status,
      (p.amount_cents / 100).toFixed(2),
      (p.currency || "usd").toUpperCase(),
      profile?.email ?? "",
      profile?.full_name ?? "",
      cohort?.name ?? "",
      p.stripe_payment_intent_id ?? "",
      p.stripe_session_id ?? "",
      p.created_at,
    ];
  });

  const csv = toCsv(
    [
      "id",
      "status",
      "amount",
      "currency",
      "email",
      "full_name",
      "cohort",
      "stripe_payment_intent_id",
      "stripe_session_id",
      "created_at",
    ],
    rows,
  );
  return csvResponse(
    `batch0-payments-${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
  );
}
