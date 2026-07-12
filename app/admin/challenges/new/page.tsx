import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { ChallengeEditor } from "../challenge-editor";

export const metadata = { title: "New challenge · Admin" };

export default async function NewChallengePage() {
  await requireAdmin();
  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/admin/challenges"
        className="text-xs text-ink-faint hover:text-ink"
      >
        ← Challenges
      </Link>
      <h1 className="mt-2 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        New challenge
      </h1>
      <p className="mt-1 text-sm text-ink-faint">
        Draft it here, then set it live from the challenges list to show the
        marquee.
      </p>
      <Card className="mt-6">
        <ChallengeEditor initial={null} />
      </Card>
    </div>
  );
}
