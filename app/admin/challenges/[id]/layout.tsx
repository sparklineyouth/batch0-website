import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getChallengeById, KIND_LABELS, challengePhase, PHASE_LABELS } from "@/lib/challenges";
import { ChallengeTabs } from "./challenge-tabs";
import { ChallengeRowActions } from "../challenge-row-actions";

export const dynamic = "force-dynamic";

/**
 * Shared chrome for one challenge in admin: title, status controls, and the
 * Edit / Submissions / Registrations tabs with live counts.
 */
export default async function ChallengeAdminLayout(props: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await props.params;
  await requirePermission("challenges.manage");
  const challenge = await getChallengeById(id);
  if (!challenge) notFound();

  const admin = createAdminClient();
  const [{ count: regs }, { count: subs }, { count: drafts }] = await Promise.all([
    admin.from("challenge_registrations").select("id", { count: "exact", head: true }).eq("challenge_id", id),
    admin
      .from("challenge_submissions")
      .select("id", { count: "exact", head: true })
      .eq("challenge_id", id)
      .neq("status", "draft"),
    admin
      .from("challenge_submissions")
      .select("id", { count: "exact", head: true })
      .eq("challenge_id", id)
      .eq("status", "draft"),
  ]);
  const phase = challengePhase(challenge);

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/admin/challenges" className="text-xs text-ink-faint hover:text-ink">
        ← All challenges
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
            {KIND_LABELS[challenge.kind]} · {challenge.status === "active" ? PHASE_LABELS[phase] : challenge.status}
          </p>
          <h1 className="mt-1 font-display text-3xl text-ink">{challenge.title}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a
            href={`/challenges/${challenge.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[13px] text-ink-soft hover:text-ink"
          >
            View page <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <ChallengeRowActions id={challenge.id} status={challenge.status} />
        </div>
      </div>
      <ChallengeTabs
        id={challenge.id}
        counts={{ registrations: regs ?? 0, submissions: subs ?? 0, drafts: drafts ?? 0 }}
      />
      <div className="mt-6">{props.children}</div>
    </div>
  );
}
