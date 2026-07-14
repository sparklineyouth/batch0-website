import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { rowToSubmission, HTTP_URL_RE } from "@/lib/challenges";
import { SubmissionReview } from "./submission-review";

export const metadata = { title: "Submission · Admin" };
export const dynamic = "force-dynamic";

export default async function SubmissionDetailPage({
  params,
}: {
  params: { id: string; submissionId: string };
}) {
  await requireAdmin();
  const admin = createAdminClient();

  const { data } = await admin
    .from("challenge_submissions")
    .select("*, applicant:profiles!challenge_submissions_user_id_fkey(full_name, email)")
    .eq("id", params.submissionId)
    .maybeSingle();
  if (!data) notFound();

  const sub = rowToSubmission(data);
  const applicantName =
    (data as any).applicant?.full_name ?? (data as any).applicant?.email ?? "Applicant";
  const applicantEmail = (data as any).applicant?.email ?? null;

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={`/admin/challenges/${params.id}/submissions`}
        className="text-xs text-ink-faint hover:text-ink"
      >
        ← Submissions
      </Link>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-ink">
          {applicantName}
        </h1>
        <StatusBadge status={sub.status} />
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-ink-faint">
        {applicantEmail && <span>{applicantEmail}</span>}
        <span>
          Applied <LocalTime value={sub.createdAt} mode="datetime" />
        </span>
        {sub.referralCode && (
          <span className="font-mono">ref: {sub.referralCode}</span>
        )}
      </p>

      <Card className="mt-6">
        <h2 className="mb-4 text-xs font-mono font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
          Answers
        </h2>
        <dl className="space-y-5">
          {sub.questionsSnapshot.length === 0 && (
            <p className="text-sm text-ink-faint">
              This submission has no recorded questions.
            </p>
          )}
          {sub.questionsSnapshot.map((q) => {
            const raw = (sub.answers[q.id] ?? "").trim();
            return (
              <div key={q.id}>
                <dt className="text-xs font-medium uppercase tracking-wider text-ink-faint">
                  {q.label}
                </dt>
                <dd className="mt-1 whitespace-pre-line text-sm text-ink">
                  {raw ? (
                    q.type === "url" && HTTP_URL_RE.test(raw) ? (
                      <a
                        href={raw}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-phosphor-ink underline decoration-phosphor-ink/30 underline-offset-2 hover:decoration-phosphor-ink"
                      >
                        {raw}
                      </a>
                    ) : (
                      raw
                    )
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </Card>

      <Card className="mt-6">
        <h2 className="mb-4 text-xs font-mono font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
          Review
        </h2>
        <SubmissionReview
          initial={{
            submissionId: sub.id,
            status: sub.status === "withdrawn" ? "submitted" : sub.status,
            payoutCents: sub.payoutAmountCents,
            reviewNotes: sub.reviewNotes,
            winnerPublic: sub.winnerPublic,
            publicName: sub.publicName,
            publicBlurb: sub.publicBlurb,
            publicProjectUrl: sub.publicProjectUrl,
          }}
        />
      </Card>
    </div>
  );
}
