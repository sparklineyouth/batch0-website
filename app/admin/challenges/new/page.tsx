import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { ChallengeEditor } from "../challenge-editor";

export const metadata = { title: "New challenge · Admin" };

export default async function NewChallengePage() {
  await requirePermission("challenges.manage");
  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/admin/challenges" className="text-xs text-ink-faint hover:text-ink">
        ← All challenges
      </Link>
      <h1 className="mt-2 font-display text-3xl text-ink">New hackathon or challenge</h1>
      <p className="mt-1 text-sm text-ink-faint">
        It saves as a draft. Preview the page and the form, then hit Publish.
      </p>
      <div className="mt-8">
        <ChallengeEditor initial={null} />
      </div>
    </div>
  );
}
