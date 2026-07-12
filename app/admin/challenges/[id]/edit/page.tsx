import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { Card, StatusBadge } from "@/components/ui/card";
import { getChallengeById } from "@/lib/challenges";
import { ChallengeEditor } from "../../challenge-editor";
import { challengeToInitial } from "../../challenge-initial";

export const metadata = { title: "Edit challenge · Admin" };
export const dynamic = "force-dynamic";

export default async function EditChallengePage({
  params,
}: {
  params: { id: string };
}) {
  await requireAdmin();
  const challenge = await getChallengeById(params.id);
  if (!challenge) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/admin/challenges"
        className="text-xs text-ink-faint hover:text-ink"
      >
        ← Challenges
      </Link>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          {challenge.title}
        </h1>
        <div className="flex items-center gap-3">
          <StatusBadge status={challenge.status} />
          <Link
            href={`/admin/challenges/${challenge.id}/submissions`}
            className="text-sm text-spark-ink hover:underline"
          >
            View submissions →
          </Link>
        </div>
      </div>
      <p className="mt-1 text-sm text-ink-faint">
        Set the status from the challenges list. Editing questions here never
        changes already-submitted answers.
      </p>
      <Card className="mt-6">
        <ChallengeEditor initial={challengeToInitial(challenge)} />
      </Card>
    </div>
  );
}
