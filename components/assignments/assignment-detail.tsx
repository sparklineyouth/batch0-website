import Link from "next/link";
import { renderLessonMarkdown } from "@/lib/lesson-content";
import { canEditSubmission, formatEastern } from "@/lib/assignments";
import type { StudentItem } from "@/lib/assignments-server";
import { startingWork, type DraftLoad } from "@/lib/assignment-drafts";
import { StatusChip } from "@/components/assignments/status-chip";
import { SubmitForm } from "@/components/assignments/submit-form";
import { SubmissionView } from "@/components/assignments/submission-view";

/**
 * One assignment for the student who owns it: what to do, what they handed
 * in, the feedback, and the form while it's still editable. Rendered by
 * /dashboard/assignments/[id] and /app/assignments/[id].
 */
export async function AssignmentDetail({
  item,
  draft,
  lesson,
  lessonHref,
  showTitle = true,
}: {
  item: StudentItem;
  /** The student's private draft (lib/assignments-server.ts loadAssignmentDraft). */
  draft: DraftLoad;
  lesson: { id: string; title: string } | null;
  lessonHref: (id: string) => string;
  /** The installed app puts the title in its own header. */
  showTitle?: boolean;
}) {
  const { assignment: a, submission: s, status } = item;
  const html = a.instructions ? await renderLessonMarkdown(a.instructions) : null;
  const editable = canEditSubmission(s?.status ?? null);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
        <StatusChip status={status} />
        {a.week && <span>Week {a.week}</span>}
        {a.due_at && <span>Due {formatEastern(a.due_at)}</span>}
      </div>
      {showTitle && <h1 className="mt-3 font-display text-3xl text-ink">{a.title}</h1>}
      {lesson && (
        <p className="mt-2 text-sm text-ink-soft">
          Lesson:{" "}
          <Link href={lessonHref(lesson.id)} className="text-phosphor-ink underline">
            {lesson.title}
          </Link>
        </p>
      )}
      {html && (
        <article className="blog-prose mt-6 max-w-none" dangerouslySetInnerHTML={{ __html: html }} />
      )}

      {s?.feedback && (
        <section className="mt-8 border-l-2 border-phosphor pl-4">
          <h2 className="font-mono text-xs uppercase tracking-wider text-phosphor-ink">
            {s.status === "returned" ? "Needs changes" : "Feedback"}
          </h2>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink [overflow-wrap:anywhere]">
            {s.feedback}
          </p>
        </section>
      )}

      <section className="mt-8 border-t border-line pt-6">
        <h2 className="font-mono text-xs uppercase tracking-wider text-ink-faint">Your work</h2>
        <div className="mt-4">
          {editable ? (
            <SubmitForm
              assignmentId={a.id}
              type={a.submission_type}
              initial={s ? { body: s.body ?? "", link: s.link_url ?? "" } : null}
              start={startingWork({ submission: s, draft: draft.state === "ready" ? draft.row : null })}
              autosave={draft.state === "ready" ? "on" : draft.state === "failed" ? "failed" : "off"}
              pastDue={!!a.due_at && Date.parse(a.due_at) < Date.now()}
            />
          ) : s && (s.body || s.link_url) ? (
            <SubmissionView body={s.body} link={s.link_url} />
          ) : (
            <p className="text-sm text-ink-soft">Nothing to hand in — you're excused from this one.</p>
          )}
        </div>
      </section>
    </div>
  );
}
