import { refundCents, retainedCents } from "@/lib/revenue-ledger";
import { createAdminClient } from "@/lib/supabase/admin";
import { viewerCan } from "@/lib/auth";
import { toCsv, csvResponse } from "@/lib/csv";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await viewerCan("payments.view"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("payments")
    .select(
      "id, status, amount_cents, amount_refunded_cents, paid_at, currency, stripe_payment_intent_id, stripe_session_id, created_at, profile:profiles!payments_user_id_fkey(email, full_name), cohort:cohorts(name)",
    )
    .order("created_at", { ascending: false });

  if (error) return new Response("Payment export unavailable", { status: 503 });
  const rows = (data ?? []).map((p: any) => {
    const profile = Array.isArray(p.profile) ? p.profile[0] : p.profile;
    const cohort = Array.isArray(p.cohort) ? p.cohort[0] : p.cohort;
    return [
      p.id,
      p.status,
      (p.amount_cents / 100).toFixed(2),
      (refundCents(p) / 100).toFixed(2),
      (retainedCents(p) / 100).toFixed(2),
      p.paid_at ?? "",
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
      "refunded_amount",
      "retained_amount",
      "verified_paid_at",
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
