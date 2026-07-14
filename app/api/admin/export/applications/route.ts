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
    .from("applications")
    .select(
      "id, status, created_at, submitted_at, reviewed_at, full_name, age, grade, school, city, country, parent_email, hours_per_week, team_size, referral_source, referral_code, linkedin_url, resume_url, portfolio_url, why_join, startup_idea, experience, cohort:cohorts(name), profile:profiles!applications_user_id_fkey(email)",
    )
    .order("created_at", { ascending: false });

  const rows = (data ?? []).map((a: any) => {
    const cohort = Array.isArray(a.cohort) ? a.cohort[0] : a.cohort;
    const profile = Array.isArray(a.profile) ? a.profile[0] : a.profile;
    return [
      a.id,
      a.status,
      a.created_at,
      a.submitted_at,
      a.reviewed_at,
      profile?.email ?? "",
      a.full_name ?? "",
      a.age ?? "",
      a.grade ?? "",
      a.school ?? "",
      a.city ?? "",
      a.country ?? "",
      a.parent_email ?? "",
      a.hours_per_week ?? "",
      a.team_size ?? "",
      a.referral_source ?? "",
      a.referral_code ?? "",
      a.linkedin_url ?? "",
      a.resume_url ?? "",
      a.portfolio_url ?? "",
      cohort?.name ?? "",
      a.why_join ?? "",
      a.startup_idea ?? "",
      a.experience ?? "",
    ];
  });

  const csv = toCsv(
    [
      "id",
      "status",
      "created_at",
      "submitted_at",
      "reviewed_at",
      "email",
      "full_name",
      "age",
      "grade",
      "school",
      "city",
      "country",
      "parent_email",
      "hours_per_week",
      "team_size",
      "referral_source",
      "referral_code",
      "linkedin_url",
      "resume_url",
      "portfolio_url",
      "cohort",
      "why_join",
      "startup_idea",
      "experience",
    ],
    rows,
  );
  return csvResponse(
    `batch0-applications-${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
  );
}
