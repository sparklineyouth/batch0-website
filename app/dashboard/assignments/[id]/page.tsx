import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { Card, StatusBadge } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { SubmissionForm } from "./submission-form";

export const metadata = { title: "Assignment · SparkLine" };

export default async function StudentAssignmentDetail({
  params,
}: {
  params: { id: string };
}) {
  const user = await requireUser();
  const supabase = createClient();

  const { data: assignment } = await supabase
    .from("assignments")
    .select("*, lesson:lessons(id, title), cohort:cohorts(id, name)")
    .eq("id", params.id)
    .maybeSingle();

  if (!assignment) notFound();

  // Confirm enrollment for safety (RLS already enforces it for selects).
  const { data: enrollment } = await supabase
    .from("enrollments")
    .select("id")
    .eq("user_id", user.id)
    .eq("cohort_id", assignment.cohort_id)
    .maybeSingle();
  if (!enrollment) notFound();

  const { data: submission } = await supabase
    .from("assignment_submissions")
    .select("*")
    .eq("assignment_id", assignment.id)
    .eq("user_id", user.id)
    .maybeSingle();

  // Sign URLs for already-uploaded files so the student can re-download.
  const adminCli = createAdminClient();
  const filePaths = ((submission?.files ?? []) as any[])
    .map((f: any) => f.path)
    .filter(Boolean);
  const signed = new Map<string, string>();
  if (filePaths.length > 0) {
    const { data } = await adminCli.storage
      .from("submissions")
      .createSignedUrls(filePaths, 60 * 60 * 4);
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) signed.set(item.path, item.signedUrl);
    }
  }

  const initialFiles = ((submission?.files ?? []) as any[]).map((f: any) => ({
    name: f.name,
    path: f.path,
    url: signed.get(f.path) ?? null,
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/dashboard/assignments"
        className="inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" /> All assignments
      </Link>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">
        {assignment.title}
      </h1>
      <p className="mt-1 text-sm text-white/50">
        {assignment.cohort?.name}
        {assignment.lesson?.title ? ` · ${assignment.lesson.title}` : ""}
        {assignment.due_at
          ? ` · due ${new Date(assignment.due_at).toLocaleString()}`
          : ""}
      </p>

      {assignment.description && (
        <Card className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">
            Instructions
          </h2>
          <p className="whitespace-pre-wrap text-sm text-white/80">
            {assignment.description}
          </p>
        </Card>
      )}

      {submission?.status === "graded" && (
        <Card className="mt-6 border-spark/40 bg-spark/5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold text-spark">
              Graded
              {submission.grade ? `: ${submission.grade}` : ""}
            </h2>
            <span className="text-xs text-white/50">
              {submission.graded_at
                ? new Date(submission.graded_at).toLocaleString()
                : ""}
            </span>
          </div>
          {submission.feedback && (
            <p className="mt-3 whitespace-pre-wrap text-sm text-white/80">
              {submission.feedback}
            </p>
          )}
        </Card>
      )}

      <Card className="mt-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/50">
            Your submission
          </h2>
          {submission && <StatusBadge status={submission.status} />}
        </div>
        <SubmissionForm
          assignmentId={assignment.id}
          locked={submission?.status === "graded"}
          initialContent={submission?.content ?? ""}
          initialLinks={
            ((submission?.links ?? []) as any[]).length > 0
              ? (submission!.links as any[])
              : []
          }
          initialFiles={initialFiles}
        />
      </Card>
    </div>
  );
}
