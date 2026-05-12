"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertStaff } from "@/lib/server-guards";
import { assertMentorCanAccessStudent } from "@/lib/mentor-scope";
import { notify } from "@/lib/notifications";

export async function postFileFeedback(input: {
  studentFileId?: string;
  teamFileId?: string;
  body: string;
}) {
  const { userId, role } = await assertStaff();
  const body = input.body.trim();
  if (!body) throw new Error("Empty message.");
  if (body.length > 4000) throw new Error("Message too long.");

  const admin = createAdminClient();

  let studentId: string | null = null;
  let teamId: string | null = null;
  if (input.studentFileId) {
    const { data: f } = await admin
      .from("student_files")
      .select("user_id, name")
      .eq("id", input.studentFileId)
      .maybeSingle();
    if (!f) throw new Error("File not found.");
    studentId = f.user_id as string;
    await assertMentorCanAccessStudent({
      callerId: userId,
      callerRole: role,
      studentId: studentId,
    });
  } else if (input.teamFileId) {
    const { data: f } = await admin
      .from("team_drive_files")
      .select("team_id, name")
      .eq("id", input.teamFileId)
      .maybeSingle();
    if (!f) throw new Error("File not found.");
    teamId = f.team_id;
  } else {
    throw new Error("No file selected.");
  }

  const { error } = await admin.from("file_feedback").insert({
    student_file_id: input.studentFileId ?? null,
    team_file_id: input.teamFileId ?? null,
    author_id: userId,
    body,
  });
  if (error) throw new Error(error.message);

  // Notify the file owner(s).
  try {
    if (studentId) {
      await notify({
        userId: studentId,
        type: "file_feedback",
        title: "New feedback on your file",
        body: body.slice(0, 200),
        link: "/dashboard/files",
      });
    } else if (teamId) {
      const { data: members } = await admin
        .from("team_members")
        .select("user_id")
        .eq("team_id", teamId);
      for (const m of members ?? []) {
        await notify({
          userId: m.user_id,
          type: "file_feedback",
          title: "New feedback on a team file",
          body: body.slice(0, 200),
          link: "/dashboard/team",
        });
      }
    }
  } catch {}

  if (studentId) {
    revalidatePath(`/mentor/students/${studentId}`);
    revalidatePath("/dashboard/files");
  }
  if (teamId) {
    revalidatePath(`/mentor/teams/${teamId}`);
    revalidatePath("/dashboard/team");
  }
}
