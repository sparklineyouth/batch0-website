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
  // Try the richer select (includes discord_*). If migration 0008 hasn't
  // been applied yet, fall back to the core columns so the export still
  // works.
  let data: any[] | null = null;
  const rich = await admin
    .from("profiles")
    .select(
      "id, email, full_name, role, referral_code, discord_user_id, discord_username, created_at, applications!applications_user_id_fkey(status), enrollments!enrollments_user_id_fkey(cohort:cohorts(name))",
    )
    .order("created_at", { ascending: false });
  if (rich.error && (rich.error as any).code === "42703") {
    const fallback = await admin
      .from("profiles")
      .select(
        "id, email, full_name, role, referral_code, created_at, applications!applications_user_id_fkey(status), enrollments!enrollments_user_id_fkey(cohort:cohorts(name))",
      )
      .order("created_at", { ascending: false });
    data = fallback.data;
  } else {
    data = rich.data;
  }

  const rows = (data ?? []).map((p: any) => {
    const latest = (p.applications ?? [])[0];
    const enrollment = (p.enrollments ?? [])[0];
    const cohort = enrollment
      ? (Array.isArray(enrollment.cohort)
          ? enrollment.cohort[0]
          : enrollment.cohort)
      : null;
    return [
      p.id,
      p.email,
      p.full_name ?? "",
      p.role,
      p.referral_code ?? "",
      p.discord_user_id ?? "",
      p.discord_username ?? "",
      latest?.status ?? "",
      cohort?.name ?? "",
      p.created_at,
    ];
  });

  const csv = toCsv(
    [
      "id",
      "email",
      "full_name",
      "role",
      "referral_code",
      "discord_user_id",
      "discord_username",
      "latest_application_status",
      "enrolled_cohort",
      "joined_at",
    ],
    rows,
  );
  return csvResponse(
    `sparkline-people-${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
  );
}
