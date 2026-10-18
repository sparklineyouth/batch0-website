import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser, getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";
import { loadAssignmentDraft, loadStudentAssignments } from "@/lib/assignments-server";
import { AssignmentDetail } from "@/components/assignments/assignment-detail";

export const metadata = { title: "Assignment · batch0" };

export default async function AssignmentPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const user = await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");
  if (!access.enrolled) {
    return <LockedFeature title="Assignments" applicationStatus={access.applicationStatus} />;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { items } = await loadStudentAssignments(supabase, user.id, { assignmentId: id });
  const item = items[0];
  if (!item) notFound();
  const [{ data: lesson }, draft] = await Promise.all([
    item.assignment.lesson_id
      ? supabase.from("lessons").select("id, title").eq("id", item.assignment.lesson_id).maybeSingle()
      : Promise.resolve({ data: null }),
    loadAssignmentDraft(supabase, user.id, item.assignment.id),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/dashboard/assignments"
        className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Assignments
      </Link>
      <div className="mt-4">
        <AssignmentDetail item={item} draft={draft} lesson={lesson} lessonHref={(l) => `/dashboard/course/${l}`} />
      </div>
    </div>
  );
}
