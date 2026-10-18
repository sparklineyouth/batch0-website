import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMentor, getCapabilities } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { mentorScope } from "@/lib/mentor-scope";
import { loadReviewQueue } from "@/lib/assignments-server";
import { deriveStatus } from "@/lib/assignments";
import { LocalTime } from "@/components/ui/local-time";
import { StatusChip } from "@/components/assignments/status-chip";
import { SubmissionView } from "@/components/assignments/submission-view";
import { ReviewForm } from "@/components/assignments/review-form";

export const metadata = { title: "Assignments · Mentor" };

export default async function MentorAssignmentsPage() {
  const mentor = await requireMentor();
  const caps = await getCapabilities();
  const admin = createAdminClient();
  // Same scope as the review action: program-wide for assignments.manage,
  // otherwise the mentor's own cohorts and students.
  const scope = can(caps, "assignments.manage") ? null : await mentorScope(admin, mentor.id);
  const { ready, pending, pendingTotal, recent } = await loadReviewQueue(admin, scope);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="font-display text-3xl text-ink">Assignments</h1>

      <section className="mt-8">
        <h2 className="font-mono text-xs uppercase tracking-wider text-ink-faint">
          {/* Every waiting submission, not just the 200 listed: the admin
              Overview's attention list counts the same queue. */}
          To review{pendingTotal ? ` · ${pendingTotal}` : ""}
        </h2>
        {!ready || pending.length === 0 ? (
          <p className="mt-3 border-y border-line py-8 text-center text-sm text-ink-soft">
            {ready ? "Nothing waiting." : "Assignments aren't set up yet."}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {pending.map((s) => (
              // The anchor the Overview's attention rows link to (#submission-<id>).
              <li key={s.id} id={`submission-${s.id}`} className="scroll-mt-24 py-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[15px] text-ink">
                    <Link href={`/mentor/students/${s.user_id}`} className="font-medium hover:underline">
                      {s.student.full_name || s.student.email || "Student"}
                    </Link>{" "}
                    <span className="text-ink-soft">
                      · {s.assignment.title}
                      {s.assignment.week ? ` · Week ${s.assignment.week}` : ""}
                    </span>
                  </p>
                  <span className="flex items-center gap-2 text-xs text-ink-faint">
                    <LocalTime value={s.submitted_at} mode="datetime-short" />
                    <StatusChip status={s.late ? "late" : "submitted"} />
                  </span>
                </div>
                <div className="mt-3">
                  <SubmissionView body={s.body} link={s.link_url} />
                </div>
                <div className="mt-4">
                  <ReviewForm submissionId={s.id} initialFeedback={s.feedback} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {recent.length > 0 && (
        <section className="mt-10">
          <h2 className="font-mono text-xs uppercase tracking-wider text-ink-faint">Recently reviewed</h2>
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {recent.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span className="min-w-0 text-ink">
                  {s.student.full_name || s.student.email || "Student"}
                  <span className="text-ink-soft"> · {s.assignment.title}</span>
                </span>
                <span className="flex items-center gap-2 text-xs text-ink-faint">
                  <LocalTime value={s.reviewed_at} mode="date" />
                  <StatusChip
                    status={deriveStatus({ opensAt: null, dueAt: null, submission: { status: s.status, late: s.late } })}
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
