"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { syncTeamDiscordChannels } from "@/lib/team-discord";

/**
 * Find the team the given student belongs to (if any) and re-sync its
 * Discord channel overwrites so the new mentor gains immediate access.
 * Best-effort — failures are logged, not thrown.
 */
async function resyncStudentTeamChannels(studentId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: m } = await admin
      .from("team_members")
      .select("team_id")
      .eq("user_id", studentId)
      .maybeSingle();
    if (m?.team_id) await syncTeamDiscordChannels(m.team_id);
  } catch (err) {
    console.error("[mentors] resync team channels failed", err);
  }
}

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
  await resyncStudentTeamChannels(args.studentId);
  revalidatePath("/admin/mentors");
}

export async function unassignMentor(assignmentId: string) {
  await assertAdmin();
  const admin = createAdminClient();
  // Look up the student BEFORE deletion so we know which team to resync.
  const { data: row } = await admin
    .from("mentor_assignments")
    .select("student_id")
    .eq("id", assignmentId)
    .maybeSingle();
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
  if (row?.student_id) await resyncStudentTeamChannels(row.student_id);
  revalidatePath("/admin/mentors");
}
