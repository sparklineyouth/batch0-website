import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { FilesManager } from "./files-manager";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";

export const metadata = { title: "Files · SparkLine Youth" };

export default async function StudentFilesPage() {
  const user = await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");
  if (!access.enrolled) {
    return (
      <LockedFeature
        title="Files"
        applicationStatus={access.applicationStatus}
      />
    );
  }
  const supabase = createClient();

  const { data: files } = await supabase
    .from("student_files")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-bold tracking-tight">Files</h1>
      <p className="mt-1 text-sm text-white/50">
        Your private cloud space — store anything you're working on. Files
        are private to you (your mentors can also see them when grading).
      </p>

      <Card className="mt-6">
        <FilesManager initialFiles={files ?? []} />
      </Card>
    </div>
  );
}
