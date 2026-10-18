import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { createClient } from "@/lib/supabase/server";
import { loadAssignmentDraft, loadStudentAssignments } from "@/lib/assignments-server";
import { AssignmentDetail } from "@/components/assignments/assignment-detail";
import { AppHeader, AppBody } from "@/components/app/frame";
import type { Role } from "@/lib/types";

export const metadata = { title: "Assignment · batch0" };
export const dynamic = "force-dynamic";

export default async function StudentAppAssignment(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { profile } = await requireViewer();
  const access = await getStudentAccess(profile.role as Role);
  if (!access.enrolled || access.preCohort || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { items } = await loadStudentAssignments(supabase, profile.id, { assignmentId: id });
  const item = items[0];
  if (!item) notFound();
  const [{ data: lesson }, draft] = await Promise.all([
    item.assignment.lesson_id
      ? supabase.from("lessons").select("id, title").eq("id", item.assignment.lesson_id).maybeSingle()
      : Promise.resolve({ data: null }),
    loadAssignmentDraft(supabase, profile.id, item.assignment.id),
  ]);

  return (
    <>
      <AppHeader
        title={item.assignment.title}
        eyebrow="Assignment"
        action={
          <Link
            href="/app/assignments"
            prefetch={false}
            aria-label="Back to assignments"
            className="press shrink-0 rounded-lg border border-line px-2.5 py-2 text-ink-soft active:bg-wash"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
        }
      />
      <AppBody>
        <div className="pb-10">
          <AssignmentDetail
            item={item}
            draft={draft}
            lesson={lesson}
            lessonHref={(l) => `/dashboard/course/${l}`}
            showTitle={false}
          />
        </div>
      </AppBody>
    </>
  );
}
