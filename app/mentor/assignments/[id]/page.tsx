import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { AssignmentForm } from "../assignment-form";
import { GradingPanel } from "./grading-panel";

export const metadata = { title: "Assignment · Mentor" };

export default async function MentorAssignmentDetail({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();

  const { data: assignment } = await admin
    .from("assignments")
    .select("*, cohort:cohorts(id, name), lesson:lessons(id, title)")
    .eq("id", params.id)
    .maybeSingle();

  if (!assignment) notFound();

  const [
    { data: cohorts },
    { data: modules },
    { data: lessons },
    { data: enrollments },
    { data: submissions },
  ] = await Promise.all([
    admin.from("cohorts").select("id, name").order("starts_on"),
    admin.from("modules").select("id, cohort_id, title, week").order("position"),
    admin.from("lessons").select("id, module_id, title").order("position"),
    admin
      .from("enrollments")
      .select("user_id, profile:profiles(id, email, full_name)")
      .eq("cohort_id", assignment.cohort_id),
    admin
      .from("assignment_submissions")
      .select("*")
      .eq("assignment_id", assignment.id),
  ]);

  // Build per-student rows: submission if any, else "not submitted".
  const subByUser = new Map<string, any>();
  for (const s of (submissions ?? []) as any[]) subByUser.set(s.user_id, s);

  type Row = {
    user: { id: string; email: string; full_name: string | null };
    submission: any | null;
  };
  const rows: Row[] = (enrollments ?? []).map((e: any) => ({
    user: e.profile,
    submission: subByUser.get(e.user_id) ?? null,
  }));

  // Pre-sign URLs for any submitted files so the grading panel can show them.
  const filePathsToSign: string[] = [];
  for (const s of (submissions ?? []) as any[]) {
    for (const f of s.files ?? []) {
      if (f?.path) filePathsToSign.push(f.path);
    }
  }
  const signed = new Map<string, string>();
  if (filePathsToSign.length > 0) {
    const { data } = await admin.storage
      .from("submissions")
      .createSignedUrls(filePathsToSign, 60 * 60 * 4);
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) signed.set(item.path, item.signedUrl);
    }
  }

  const submittedRows = rows.filter((r) => r.submission);
  const gradedCount = submittedRows.filter(
    (r) => r.submission?.status === "graded",
  ).length;

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/mentor/assignments"
        className="text-sm text-white/50 hover:text-white"
      >
        ← All assignments
      </Link>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {assignment.title}
          </h1>
          <p className="mt-1 text-sm text-white/50">
            {assignment.cohort?.name}
            {assignment.lesson?.title
              ? ` · attached to ${assignment.lesson.title}`
              : ""}
            {assignment.due_at
              ? ` · due ${new Date(assignment.due_at).toLocaleString()}`
              : ""}
          </p>
        </div>
      </div>

      {/* Quick stats */}
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Mini label="Enrolled" value={(rows.length).toString()} />
        <Mini
          label="Submitted"
          value={`${submittedRows.length}/${rows.length}`}
        />
        <Mini
          label="Graded"
          value={`${gradedCount}/${submittedRows.length}`}
          accent={gradedCount === submittedRows.length && submittedRows.length > 0}
        />
      </div>

      {/* Edit assignment metadata */}
      <Card className="mt-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/50">
          Assignment details
        </h2>
        <AssignmentForm
          initial={{
            id: assignment.id,
            cohort_id: assignment.cohort_id,
            lesson_id: assignment.lesson_id,
            title: assignment.title,
            description: assignment.description,
            due_at: assignment.due_at,
          }}
          cohorts={cohorts ?? []}
          modules={modules ?? []}
          lessons={lessons ?? []}
        />
      </Card>

      {/* Submissions list */}
      <Card className="mt-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/50">
          Student submissions
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-white/50">
            No students enrolled in this cohort yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => (
              <SubmissionRow
                key={r.user.id}
                row={r}
                signed={signed}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Mini({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-4">
      <div className="text-xs uppercase tracking-wider text-white/40">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-bold tracking-tight ${
          accent ? "text-spark" : "text-white"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function SubmissionRow({
  row,
  signed,
}: {
  row: {
    user: { id: string; email: string; full_name: string | null };
    submission: any | null;
  };
  signed: Map<string, string>;
}) {
  const sub = row.submission;
  return (
    <li className="rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-white">
            {row.user.full_name || "—"}
          </div>
          <div className="text-xs text-white/50">{row.user.email}</div>
        </div>
        {sub ? (
          <StatusBadge status={sub.status} />
        ) : (
          <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-[10px] uppercase tracking-wider text-white/40">
            Not submitted
          </span>
        )}
      </div>

      {sub && (
        <GradingPanel
          submissionId={sub.id}
          content={sub.content}
          links={sub.links ?? []}
          files={(sub.files ?? []).map((f: any) => ({
            name: f.name,
            url: signed.get(f.path) ?? null,
          }))}
          submittedAt={sub.submitted_at}
          status={sub.status}
          initialGrade={sub.grade ?? ""}
          initialFeedback={sub.feedback ?? ""}
        />
      )}
    </li>
  );
}
