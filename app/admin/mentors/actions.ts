"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";

export async function assignMentor(args: {
  mentorId: string;
  studentId: string;
  cohortId: string | null;
}) {
  await assertAdmin();
  const admin = createAdminClient();
  const { error } = await admin.from("mentor_assignments").upsert(
    {
      mentor_id: args.mentorId,
      student_id: args.studentId,
      cohort_id: args.cohortId,
    },
    { onConflict: "mentor_id,student_id" },
  );
  if (error) throw new Error(error.message);
  await logAudit({
    action: "mentor.assigned",
    targetType: "student",
    targetId: args.studentId,
    payload: { mentor_id: args.mentorId, cohort_id: args.cohortId },
  });
  revalidatePath("/admin/mentors");
}

export async function unassignMentor(assignmentId: string) {
  await assertAdmin();
  const admin = createAdminClient();
  const { error } = await admin
    .from("mentor_assignments")
    .delete()
    .eq("id", assignmentId);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "mentor.unassigned",
    targetType: "mentor_assignment",
    targetId: assignmentId,
  });
  revalidatePath("/admin/mentors");
}
