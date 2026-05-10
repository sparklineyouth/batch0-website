import { createAdminClient } from "@/lib/supabase/admin";
import { requireMentor } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { NotesEditor } from "./notes-editor";

export const metadata = { title: "My students · Mentor" };

export default async function MentorStudentsPage() {
  const profile = await requireMentor();
  const admin = createAdminClient();

  const { data: assignments } = await admin
    .from("mentor_assignments")
    .select(
      "id, notes, student:profiles!mentor_assignments_student_id_fkey(id, email, full_name), cohort:cohorts(name)",
    )
    .eq("mentor_id", profile.id);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-bold tracking-tight">My students</h1>
      <p className="mt-1 text-sm text-white/50">
        Track who you're mentoring. Notes are private to you and admins.
      </p>

      <div className="mt-8 space-y-4">
        {(assignments?.length ?? 0) === 0 && (
          <Card>
            <p className="text-sm text-white/50">No assignments yet.</p>
          </Card>
        )}
        {(assignments ?? []).map((a: any) => {
          const student = Array.isArray(a.student) ? a.student[0] : a.student;
          const cohort = Array.isArray(a.cohort) ? a.cohort[0] : a.cohort;
          return (
            <Card key={a.id}>
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-white">
                    {student?.full_name || "—"}
                  </div>
                  <div className="text-xs text-white/50">{student?.email}</div>
                </div>
                <div className="text-xs text-white/40">
                  {cohort?.name ?? ""}
                </div>
              </div>
              <div className="mt-4">
                <NotesEditor assignmentId={a.id} initialNotes={a.notes ?? ""} />
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
