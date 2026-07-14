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
    .from("user_charges")
    .select(
      "id, kind, status, amount_cents, description, created_at, paid_at, waived_at, waiver_reason, profile:profiles!user_charges_user_id_fkey(email, full_name)",
    )
    .order("created_at", { ascending: false });

  const rows = (data ?? []).map((c: any) => {
    const profile = Array.isArray(c.profile) ? c.profile[0] : c.profile;
    return [
      c.id,
      c.kind,
      c.status,
      (c.amount_cents / 100).toFixed(2),
      c.description,
      profile?.email ?? "",
      profile?.full_name ?? "",
      c.created_at,
      c.paid_at ?? "",
      c.waived_at ?? "",
      c.waiver_reason ?? "",
    ];
  });

  const csv = toCsv(
    [
      "id",
      "kind",
      "status",
      "amount",
      "description",
      "email",
      "full_name",
      "created_at",
      "paid_at",
      "waived_at",
      "waiver_reason",
    ],
    rows,
  );
  return csvResponse(
    `batch0-charges-${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
  );
}
