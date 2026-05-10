import { createAdminClient } from "@/lib/supabase/admin";
import { requireMentor } from "@/lib/auth";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Notes · Mentor" };

export default async function MentorNotesPage() {
  const profile = await requireMentor();
  const admin = createAdminClient();

  const { data: assignments } = await admin
    .from("mentor_assignments")
    .select(
      "id, notes, student:profiles!mentor_assignments_student_id_fkey(full_name, email)",
    )
    .eq("mentor_id", profile.id)
    .not("notes", "is", null)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">My notes</h1>
      <p className="mt-1 text-sm text-white/50">
        All your mentor notes in one place.
      </p>

      <div className="mt-6 space-y-4">
        {(assignments?.length ?? 0) === 0 && (
          <Card>
            <p className="text-sm text-white/50">No notes yet.</p>
          </Card>
        )}
        {(assignments ?? []).map((a: any) => {
          const student = Array.isArray(a.student) ? a.student[0] : a.student;
          return (
            <Card key={a.id}>
              <div className="text-sm font-semibold text-white">
                {student?.full_name || "—"}
              </div>
              <div className="text-xs text-white/40">{student?.email}</div>
              <p className="mt-3 whitespace-pre-wrap text-sm text-white/70">
                {a.notes}
              </p>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
