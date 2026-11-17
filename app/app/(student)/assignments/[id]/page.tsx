import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, CircleHelp } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { createClient } from "@/lib/supabase/server";
import { loadAssignmentDraft, loadStudentAssignments } from "@/lib/assignments-server";
import { AssignmentDetail } from "@/components/assignments/assignment-detail";
import { askAboutHref } from "@/lib/chat-threads-rules";
import { AppHeader, AppBody, Row } from "@/components/app/frame";
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
          {/* "Ask about this" (Chat threads, 0110), as on the web page: #help,
              with this assignment linked by id only — never the draft or the
              submission. Chat keeps the link only if the sender can open the
              assignment, and shows its title only to readers who can
              (lib/chat-about.ts). /chat is a full page, so it leaves the app
              shell, like More's Chat row. */}
          <div className="mt-8 rounded-2xl border border-line px-4 sm:px-5">
            <Row
              label="Ask about this assignment"
              value="In #help, with this assignment linked"
              href={askAboutHref("assignment", item.assignment.id)}
              prefetch={false}
              leading={<CircleHelp className="h-[18px] w-[18px] shrink-0 text-ink-faint" aria-hidden />}
              right={<ArrowUpRight className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />}
            />
          </div>
        </div>
      </AppBody>
    </>
  );
}
