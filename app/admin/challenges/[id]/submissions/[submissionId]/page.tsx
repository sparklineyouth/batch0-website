import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { AnswerList, uploadPathsIn } from "@/components/challenges/answer-view";
import {
  rowToSubmission,
  getChallengeById,
  getReferralProgress,
  challengeWindowState,
  CHALLENGE_UPLOAD_BUCKET,
} from "@/lib/challenges";
import { SubmissionReview } from "./submission-review";

export const metadata = { title: "Submission · Admin" };
export const dynamic = "force-dynamic";

export default async function SubmissionDetailPage(props: {
  params: Promise<{ id: string; submissionId: string }>;
}) {
  const params = await props.params;
  await requirePermission("challenges.manage");
  const admin = createAdminClient();

  const [{ data }, challenge] = await Promise.all([
    admin
      .from("challenge_submissions")
      .select("*, applicant:profiles!challenge_submissions_user_id_fkey(full_name, email, referral_code)")
      .eq("id", params.submissionId)
      .maybeSingle(),
    getChallengeById(params.id),
  ]);
  if (!data || !challenge) notFound();

  const sub = rowToSubmission(data);
  const applicant = Array.isArray((data as any).applicant) ? (data as any).applicant[0] : (data as any).applicant;
  const applicantName = applicant?.full_name ?? applicant?.email ?? "Entrant";

  // Uploads live in a private bucket — mint short-lived URLs in one batch.
  const paths = uploadPathsIn(sub.questionsSnapshot, sub.answers);
  const signed: Record<string, string> = {};
  if (paths.length) {
    const { data: urls } = await admin.storage
      .from(CHALLENGE_UPLOAD_BUCKET)
      .createSignedUrls(paths, 3600);
    for (const u of urls ?? []) if (u.path && u.signedUrl) signed[u.path] = u.signedUrl;
  }

  const referral =
    challenge.referralsRequired > 0
      ? await getReferralProgress(challenge, sub.userId, applicant?.referral_code ?? null, admin)
      : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        <Link href={`/admin/challenges/${params.id}/submissions`} className="text-xs text-ink-faint hover:text-ink">
          ← Submissions
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-2xl text-ink">{applicantName}</h2>
          <StatusBadge status={sub.status === "funded" ? "winner" : sub.status} />
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-ink-faint">
          {applicant?.email && <span>{applicant.email}</span>}
          {sub.submittedAt ? (
            <span>
              Submitted <LocalTime value={sub.submittedAt} mode="datetime" />
            </span>
          ) : (
            <span>Draft · last edited <LocalTime value={sub.updatedAt} mode="datetime" /></span>
          )}
          {sub.submittedAt && sub.updatedAt !== sub.createdAt && (
            <span>
              · last change <LocalTime value={sub.updatedAt} mode="datetime-short" />
            </span>
          )}
          {referral && (
            <span className="font-mono">
              · referrals {referral.count}/{referral.required}
            </span>
          )}
        </p>

        <Card className="mt-6">
          <AnswerList questions={sub.questionsSnapshot} answers={sub.answers} signed={signed} />
        </Card>

        {referral && referral.friends.length > 0 && (
          <Card className="mt-6">
            <h3 className="mb-3 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
              Friends they brought
            </h3>
            <ul className="flex flex-wrap gap-2 text-[13px]">
              {referral.friends.map((f, i) => (
                <li key={i} className="rounded-full border border-line px-2.5 py-1">
                  {f.name} <span className="text-ink-faint">· {f.source}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div className="lg:pt-8">
        <Card className="lg:sticky lg:top-6">
          <h3 className="mb-4 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
            Review
          </h3>
          {sub.status === "draft" ? (
            <p className="text-sm text-ink-soft">
              Still a draft — you can review it once they submit.
            </p>
          ) : (
            <SubmissionReview
              prizes={challenge.prizes}
              winnersPublished={challenge.winnersPublished}
              editWindowOpenUntil={
                challenge.allowEdits && challenge.closesAt && challengeWindowState(challenge) === "open"
                  ? challenge.closesAt
                  : null
              }
              initial={{
                submissionId: sub.id,
                status: sub.status === "withdrawn" ? "submitted" : (sub.status as any),
                prizeId: sub.prizeId,
                awardLabel: sub.awardLabel,
                payoutCents: sub.payoutAmountCents,
                reviewNotes: sub.reviewNotes,
                winnerPublic: sub.winnerPublic,
                publicName: sub.publicName,
                publicBlurb: sub.publicBlurb,
                publicProjectUrl: sub.publicProjectUrl,
              }}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
