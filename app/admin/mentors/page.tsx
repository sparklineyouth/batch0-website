import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { AssignmentManager } from "./assignment-manager";

export const metadata = { title: "Mentor assignments · Admin" };

export default async function AdminMentorsPage() {
  const admin = createAdminClient();

  const [{ data: mentors }, { data: students }, { data: assignments }, { data: cohorts }] =
    await Promise.all([
      admin
        .from("profiles")
        .select("id, email, full_name")
        .eq("role", "mentor")
        .order("created_at", { ascending: false }),
      admin
        .from("profiles")
        .select(
          "id, email, full_name, enrollments(cohort_id, cohort:cohorts(name))",
        )
        .eq("role", "student")
        .order("created_at", { ascending: false }),
      admin
        .from("mentor_assignments")
        .select(
          "id, mentor_id, student_id, cohort_id, mentor:profiles!mentor_assignments_mentor_id_fkey(full_name, email), student:profiles!mentor_assignments_student_id_fkey(full_name, email), cohort:cohorts(name)",
        )
        .order("created_at", { ascending: false }),
      admin.from("cohorts").select("id, name").order("starts_on"),
    ]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight">Mentor assignments</h1>
      <p className="mt-1 text-sm text-white/50">
        Pair students with mentors. Each pair shows up in the mentor's
        dashboard so they can take notes.
      </p>

      <Card className="mt-6">
        <AssignmentManager
          mentors={(mentors ?? []) as any}
          students={(students ?? []) as any}
          cohorts={(cohorts ?? []) as any}
          assignments={(assignments ?? []) as any}
        />
      </Card>
    </div>
  );
}
