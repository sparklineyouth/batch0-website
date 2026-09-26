import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { ChallengeCover } from "@/components/challenges/cover";
import { ChallengeRowActions } from "./challenge-row-actions";
import {
  rowToChallenge,
  challengePhase,
  prizeHeadline,
  KIND_LABELS,
  PHASE_LABELS,
} from "@/lib/challenges";

export const metadata = { title: "Challenges · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

const FILTERS = ["all", "draft", "active", "closed", "archived"] as const;
const FILTER_LABEL: Record<(typeof FILTERS)[number], string> = {
  all: "All",
  draft: "Drafts",
  active: "Published",
  closed: "Closed",
  archived: "Archived",
};

function count(rel: unknown): number {
  return Array.isArray(rel) ? ((rel[0] as any)?.count ?? 0) : 0;
}

export default async function AdminChallengesPage(props: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await props.searchParams;
  await requirePermission("challenges.manage");
  const admin = createAdminClient();

  let q = admin
    .from("challenges")
    .select(
      "*, registrations:challenge_registrations(count), submissions:challenge_submissions(status)",
    )
    .order("created_at", { ascending: false });
  if (status && status !== "all") q = q.eq("status", status);
  else q = q.neq("status", "archived");
  const { data: rows, error } = await q;
  if (error) console.error("[admin/challenges] list failed", error);

  const challenges = (rows ?? []).map((r: any) => ({
    ...rowToChallenge(r),
    registrations: count(r.registrations),
    // Drafts are counted out here rather than in the embed filter, which
    // PostgREST applies inconsistently alongside an aggregate.
    submitted: Array.isArray(r.submissions)
      ? r.submissions.filter((x: any) => x.status !== "draft").length
      : 0,
  }));

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl text-ink">Hackathons &amp; challenges</h1>
          <p className="mt-1 text-sm text-ink-faint">
            Each one gets an event page people register for, then submit to. Published ones show on{" "}
            <a href="/challenges" target="_blank" className="underline">/challenges</a>.
          </p>
        </div>
        <ButtonLink href="/admin/challenges/new">New challenge</ButtonLink>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = (status ?? "all") === f;
          return (
            <Link
              key={f}
              href={f === "all" ? "/admin/challenges" : `/admin/challenges?status=${f}`}
              className={`rounded-full border px-3 py-1 text-xs ${
                active ? "border-phosphor/40 bg-phosphor/10 text-phosphor-ink" : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              {FILTER_LABEL[f]}
            </Link>
          );
        })}
      </div>

      {challenges.length === 0 ? (
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Nothing here.{" "}
            <Link href="/admin/challenges/new" className="text-phosphor-ink hover:underline">
              Create one
            </Link>
            .
          </p>
        </Card>
      ) : (
        <ul className="mt-6 space-y-3">
          {challenges.map((c) => {
            const phase = challengePhase(c);
            const headline = prizeHeadline(c);
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-paper p-3 sm:flex-nowrap">
                <Link href={`/admin/challenges/${c.id}/edit`} className="w-16 shrink-0">
                  <ChallengeCover title={c.title} kind={c.kind} imageUrl={c.coverImageUrl} theme={c.coverTheme} size="sm" />
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{KIND_LABELS[c.kind]}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                        c.status === "draft"
                          ? "border border-dashed border-line text-ink-faint"
                          : phase === "live"
                            ? "bg-phosphor text-on-phosphor"
                            : "bg-wash text-ink-soft"
                      }`}
                    >
                      {c.status === "active" ? PHASE_LABELS[phase] : c.status}
                    </span>
                    {c.featured && <span className="font-mono text-[10px] uppercase text-phosphor-ink">★ banner</span>}
                    {c.referralsRequired > 0 && (
                      <span className="font-mono text-[10px] uppercase text-ink-faint">{c.referralsRequired} referrals req.</span>
                    )}
                  </div>
                  <Link href={`/admin/challenges/${c.id}/edit`} className="mt-1 block truncate font-medium text-ink hover:underline">
                    {c.title}
                  </Link>
                  <p className="mt-0.5 truncate text-xs text-ink-faint">
                    {[
                      headline,
                      c.closesAt ? null : "no deadline",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    {c.closesAt && (
                      <>
                        {headline ? " · " : ""}due <LocalTime value={c.closesAt} mode="datetime-short" />
                      </>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-4 text-sm">
                  <Link href={`/admin/challenges/${c.id}/registrations`} className="text-center hover:underline">
                    <span className="block font-mono text-ink">{c.registrations}</span>
                    <span className="block text-[11px] text-ink-faint">registered</span>
                  </Link>
                  <Link href={`/admin/challenges/${c.id}/submissions`} className="text-center hover:underline">
                    <span className="block font-mono text-ink">{c.submitted}</span>
                    <span className="block text-[11px] text-ink-faint">submitted</span>
                  </Link>
                </div>
                <div className="w-full sm:w-auto">
                  <ChallengeRowActions id={c.id} status={c.status} closesAt={c.closesAt} compact />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
