import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getUser, viewerCan } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import {
  getChallengeBySlug,
  getEntrantState,
  getReferralProgress,
  canRegister,
  challengeReferralLink,
  CHALLENGE_UPLOAD_BUCKET,
  KIND_LABELS,
} from "@/lib/challenges";
import { AnswerList, uploadPathsIn } from "@/components/challenges/answer-view";
import { ChallengeCover } from "@/components/challenges/cover";
import { SubmissionForm } from "./submission-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Submit · batch0",
  robots: { index: false, follow: false },
};

async function signPaths(paths: string[]): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const admin = createAdminClient();
  const { data } = await admin.storage
    .from(CHALLENGE_UPLOAD_BUCKET)
    .createSignedUrls(paths.slice(0, 60), 3600);
  const out: Record<string, string> = {};
  for (const row of data ?? []) {
    if (row.path && row.signedUrl) out[row.path] = row.signedUrl;
  }
  return out;
}

export default async function SubmitPage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ preview?: string }>;
}) {
  const [{ slug }, searchParams] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
  const user = await getUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/challenges/${slug}/submit`)}`);
  }
  const challenge = await getChallengeBySlug(slug);
  if (!challenge) notFound();
  const isStaff = await viewerCan("challenges.manage");
  if (challenge.status === "draft" && !isStaff) notFound();
  const preview = isStaff && (searchParams.preview === "1" || challenge.status === "draft");

  const entrant = await getEntrantState(challenge.id, user.id);
  const sub = entrant.submission;
  const regOpen = canRegister(challenge);
  const eventHref = `/challenges/${challenge.slug}`;

  // Deadline passed (or entry already judged): show what they sent, read-only.
  const locked =
    !preview &&
    (!regOpen || (sub && !["draft", "submitted"].includes(sub.status)));
  if (locked) {
    const signed = sub
      ? await signPaths(uploadPathsIn(sub.questionsSnapshot, sub.answers))
      : {};
    return (
      <Shell eventHref={eventHref} title={challenge.title}>
        {sub && sub.status !== "draft" ? (
          <>
            <p className="mt-2 text-sm text-ink-soft">
              Submitted — this is the version we&apos;re judging.
            </p>
            <div className="mt-6 rounded-xl border border-line bg-paper p-5 sm:p-6">
              <AnswerList
                questions={sub.questionsSnapshot}
                answers={sub.answers}
                signed={signed}
              />
            </div>
          </>
        ) : (
          <div className="mt-6 rounded-xl border border-line bg-wash p-6">
            <p className="font-semibold text-ink">Submissions are closed</p>
            <p className="mt-1 text-sm text-ink-soft">
              {sub
                ? "Your draft wasn't submitted before the deadline."
                : "This one has wrapped up."}{" "}
              New challenges drop often.
            </p>
            <Link href="/challenges" className="mt-4 inline-block text-sm font-medium text-ink underline decoration-phosphor decoration-2 underline-offset-2">
              See what&apos;s live →
            </Link>
          </div>
        )}
      </Shell>
    );
  }

  const [referral, previews] = await Promise.all([
    challenge.referralsRequired > 0 && !preview
      ? getReferralProgress(challenge, user.id, entrant.referralCode)
      : Promise.resolve(null),
    sub ? signPaths(uploadPathsIn(challenge.questions, sub.answers)) : Promise.resolve({}),
  ]);

  return (
    <div className="min-h-screen bg-paper">
      <main id="main-content" tabIndex={-1}>
        <SubmissionForm
          challenge={{
            slug: challenge.slug,
            title: challenge.title,
            kindLabel: KIND_LABELS[challenge.kind],
            kind: challenge.kind,
            questions: challenge.questions,
            status: challenge.status,
            opensAt: challenge.opensAt,
            closesAt: challenge.closesAt,
            allowEdits: challenge.allowEdits,
            referralsRequired: challenge.referralsRequired,
          }}
          cover={
            <ChallengeCover
              title={challenge.title}
              kind={challenge.kind}
              imageUrl={challenge.coverImageUrl}
              theme={challenge.coverTheme}
              size="xs"
            />
          }
          initialAnswers={sub?.answers ?? {}}
          initialStatus={sub?.status ?? null}
          initialSubmittedAt={sub?.submittedAt ?? null}
          initialVersion={sub?.updatedAt ?? null}
          initialPreviews={previews}
          referral={
            referral
              ? {
                  ...referral,
                  link: entrant.referralCode
                    ? challengeReferralLink(env.siteUrl, challenge.slug, entrant.referralCode)
                    : null,
                }
              : null
          }
          preview={preview}
        />
      </main>
    </div>
  );
}

function Shell({
  eventHref,
  title,
  children,
}: {
  eventHref: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-paper">
      <div className="mx-auto max-w-2xl px-5 py-10 sm:px-6">
        <Link href={eventHref} className="inline-flex items-center gap-1.5 text-[13px] text-ink-soft hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to event
        </Link>
        <h1 className="mt-4 font-display text-4xl text-ink">{title}</h1>
        {children}
      </div>
    </main>
  );
}
