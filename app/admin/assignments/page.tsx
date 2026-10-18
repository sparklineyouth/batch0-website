import Link from "next/link";
import { Download } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCohortBoard, loadFeedbackQueue } from "@/lib/assignments-server";
import { cohortWeekCount, formatEastern, formatEasternDay } from "@/lib/assignments";
import { isUuid } from "@/lib/support-access";
import { buttonClasses } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { AssignmentEditor, type EditorAssignment } from "./assignment-editor";
import { CompletionMatrix } from "./completion-matrix";

export const metadata = { title: "Assignments · Admin" };
export const dynamic = "force-dynamic";

const STATUS_NOTE: Record<string, string> = { draft: "Draft", archived: "Archived" };

/** How many of the longest-waiting submissions the "Waiting for feedback" list shows; its count is exact. */
const WAITING_LIST_MAX = 10;

export default async function AdminAssignmentsPage(props: {
  searchParams: Promise<{ cohort?: string; filter?: string; review?: string }>;
}) {
  await requirePermission("assignments.manage");
  const searchParams = await props.searchParams;
  const admin = createAdminClient();
  const { data: cohortRows } = await admin
    .from("cohorts")
    .select("id, name, starts_on, ends_on, status")
    .neq("status", "cancelled")
    .order("starts_on", { ascending: false, nullsFirst: false });
  const cohorts = cohortRows ?? [];
  const cohort =
    cohorts.find((c) => c.id === searchParams.cohort) ??
    cohorts.find((c) => c.status === "active") ??
    cohorts.find((c) => c.status === "upcoming") ??
    cohorts[0];

  if (!cohort) {
    return (
      <div className="mx-auto max-w-6xl">
        <h1 className="font-display text-3xl text-ink">Assignments</h1>
        <p className="mt-8 border-y border-line py-10 text-center text-sm text-ink-soft">Create a cohort first.</p>
      </div>
    );
  }

  const now = new Date();
  const [board, { data: modules }, waiting] = await Promise.all([
    loadCohortBoard(admin, cohort.id, now),
    admin
      .from("modules")
      .select("week, position, lessons(id, title, position)")
      .eq("cohort_id", cohort.id)
      .order("week", { ascending: true })
      .order("position", { ascending: true }),
    // Program-wide, whichever cohort is selected: the same read, scope and
    // count as the Overview's Feedback source for this permission, so the
    // number there is a number here.
    loadFeedbackQueue(admin, null, { limit: WAITING_LIST_MAX }),
  ]);
  const cohortName = new Map(cohorts.map((c) => [c.id, c.name]));
  const lessons = (modules ?? []).flatMap((m: any) =>
    [...(m.lessons ?? [])]
      .sort((a: any, b: any) => a.position - b.position)
      .map((l: any) => ({ id: l.id as string, title: l.title as string, week: m.week as number })),
  );
  const editorCohort = {
    id: cohort.id,
    name: cohort.name,
    startsOn: cohort.starts_on,
    weekCount: cohortWeekCount(cohort.starts_on, cohort.ends_on),
  };
  const students = board.students.map((s) => ({ userId: s.userId, name: s.name, email: s.email }));
  const handedIn = new Map<string, number>();
  for (const s of board.submissions) {
    if (s.status !== "excused") handedIn.set(s.assignment_id, (handedIn.get(s.assignment_id) ?? 0) + 1);
  }
  const nameOf = new Map(board.students.map((s) => [s.userId, s.name || s.email || "Student"]));
  // ?review=<assignment id>:<student id> opens that cell's review drawer —
  // the link a "Waiting for feedback" row on the Overview carries.
  const [reviewAssignment, reviewStudent] = (searchParams.review ?? "").split(":");
  const initialCell =
    isUuid(reviewAssignment) && isUuid(reviewStudent)
      ? { assignmentId: reviewAssignment.toLowerCase(), userId: reviewStudent.toLowerCase() }
      : null;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl text-ink">Assignments</h1>
        {board.ready && (
          <div className="flex items-center gap-2">
            <a
              href={`/admin/assignments/export?cohort=${cohort.id}`}
              className={buttonClasses("secondary", "sm")}
            >
              <Download className="h-3.5 w-3.5" /> CSV
            </a>
            <AssignmentEditor cohort={editorCohort} lessons={lessons} students={students} />
          </div>
        )}
      </div>

      {cohorts.length > 1 && (
        <nav className="mt-5 flex flex-wrap gap-2" aria-label="Cohort">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              href={`/admin/assignments?cohort=${c.id}`}
              className={`rounded-full border px-3 py-1 text-xs ${
                c.id === cohort.id ? "border-phosphor bg-phosphor/15 text-ink" : "border-line text-ink-soft hover:text-ink"
              }`}
            >
              {c.name}
            </Link>
          ))}
        </nav>
      )}

      {!board.ready ? (
        <p className="mt-8 border-y border-line py-10 text-center text-sm text-ink-soft">
          Assignments aren&apos;t set up yet.
        </p>
      ) : (
        <>
          {waiting.failed ? (
            <p role="status" className="mt-8 text-xs text-red-600 dark:text-red-400">
              Couldn&apos;t load the work waiting for feedback just now. Reload to try again.
            </p>
          ) : (
            waiting.total > 0 && (
              <section id="waiting-feedback" className="mt-8 scroll-mt-24">
                <h2 className="font-mono text-xs uppercase tracking-wider text-ink-faint">
                  Waiting for feedback · {waiting.total.toLocaleString("en-US")}
                </h2>
                <ul className="mt-3 divide-y divide-line border-y border-line">
                  {waiting.items.map((w) => (
                    <li key={w.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                      <div className="min-w-0 flex-1 basis-56">
                        <p className="truncate text-sm text-ink">
                          {w.studentName || "Student"}
                          <span className="text-ink-soft">
                            {" "}
                            · {w.assignment.title}
                            {w.assignment.week ? ` · Week ${w.assignment.week}` : ""}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-ink-faint">
                          {cohorts.length > 1 && cohortName.get(w.assignment.cohortId)
                            ? `${cohortName.get(w.assignment.cohortId)} · `
                            : ""}
                          {w.submittedAt ? (
                            <>
                              Submitted <LocalTime value={w.submittedAt} mode="datetime-short" />
                            </>
                          ) : (
                            "Submitted"
                          )}
                          {w.late ? " · late" : ""}
                        </p>
                      </div>
                      <Link
                        href={`/admin/assignments?cohort=${w.assignment.cohortId}&review=${w.assignmentId}:${w.userId}`}
                        prefetch={false}
                        className={buttonClasses("secondary", "sm")}
                      >
                        Review
                      </Link>
                    </li>
                  ))}
                </ul>
                {waiting.total > waiting.items.length && (
                  <p className="mt-2 text-xs text-ink-faint">
                    Showing the {waiting.items.length} longest-waiting of {waiting.total.toLocaleString("en-US")}.
                  </p>
                )}
              </section>
            )
          )}

          <section className="mt-8">
            <h2 className="font-mono text-xs uppercase tracking-wider text-ink-faint">Progress</h2>
            <div className="mt-3">
              <CompletionMatrix
                columns={board.columns.map((a) => ({ id: a.id, title: a.title, week: a.week, dueAt: a.due_at }))}
                rows={board.rows.map((r) => ({ ...r, name: nameOf.get(r.userId) ?? "Student" }))}
                missingOnly={searchParams.filter === "missing"}
                initialCell={initialCell}
              />
            </div>
          </section>

          <section className="mt-10">
            <h2 className="font-mono text-xs uppercase tracking-wider text-ink-faint">
              All assignments · {board.assignments.length}
            </h2>
            {board.assignments.length === 0 ? (
              <p className="mt-3 border-y border-line py-8 text-center text-sm text-ink-soft">None yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line border-y border-line">
                {board.assignments.map((a) => {
                  const audienceSize = a.audience === "students" ? (board.targets.get(a.id)?.size ?? 0) : students.length;
                  const notOpen = a.opens_at && Date.parse(a.opens_at) > now.getTime();
                  const initial: EditorAssignment = {
                    ...a,
                    targets: [...(board.targets.get(a.id) ?? [])],
                    handedIn: handedIn.get(a.id) ?? 0,
                  };
                  return (
                    <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] text-ink">
                          {a.title}
                          {STATUS_NOTE[a.status] && (
                            <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                              {STATUS_NOTE[a.status]}
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-xs text-ink-faint">
                          {[
                            a.week ? `Week ${a.week}` : null,
                            notOpen ? `Opens ${formatEasternDay(a.opens_at)}` : null,
                            a.due_at ? `Due ${formatEastern(a.due_at)}` : "No due date",
                            a.audience === "students" ? `${audienceSize} student${audienceSize === 1 ? "" : "s"}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <span className="font-mono text-xs tabular-nums text-ink-soft">
                        {handedIn.get(a.id) ?? 0}/{audienceSize} in
                      </span>
                      <AssignmentEditor cohort={editorCohort} lessons={lessons} students={students} initial={initial} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
