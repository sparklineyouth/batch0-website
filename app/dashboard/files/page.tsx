import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { FilesManager } from "./files-manager";

export const metadata = { title: "Files · SparkLine" };

export default async function StudentFilesPage() {
  const user = await requireUser();
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
        are private to you (your professors can also see them when grading).
      </p>

      <Card className="mt-6">
        <FilesManager initialFiles={files ?? []} />
      </Card>
    </div>
  );
}
