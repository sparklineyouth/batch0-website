import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { formatCents } from "@/lib/challenges";

export const metadata = { title: "Submissions · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

const FILTERS = ["all", "submitted", "shortlisted", "funded", "rejected"];

export default async function ChallengeSubmissionsPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { status?: string };
}) {
  await requireAdmin();
  const admin = createAdminClient();
  const status = searchParams.status;

  const { data: challenge } = await admin
    .from("challenges")
    .select("id, title, slug")
    .eq("id", params.id)
    .maybeSingle();
  if (!challenge) notFound();

  let q = admin
    .from("challenge_submissions")
    .select(
      "id, status, created_at, payout_amount_cents, winner_public, applicant:profiles!challenge_submissions_user_id_fkey(full_name, email)",
    )
    .eq("challenge_id", params.id)
    .order("created_at", { ascending: false });
  if (status && status !== "all") q = q.eq("status", status);
  const { data: subs } = await q;

  const rows = (subs ?? []).map((s: any) => ({
    id: s.id as string,
    status: s.status as string,
    createdAt: s.created_at as string,
    payoutCents: s.payout_amount_cents as number | null,
    winnerPublic: s.winner_public as boolean,
    name: s.applicant?.full_name ?? s.applicant?.email ?? "Applicant",
    email: s.applicant?.email ?? null,
  }));

  return (
    <div className="mx-auto max-w-4xl">
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
        <Link
          href={`/admin/challenges/${challenge.id}/edit`}
          className="text-sm text-spark-ink hover:underline"
        >
          Edit challenge →
        </Link>
      </div>
      <p className="mt-1 text-sm text-ink-faint">
        {rows.length} submission{rows.length === 1 ? "" : "s"}
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = (status ?? "all") === f;
          const href =
            f === "all"
              ? `/admin/challenges/${challenge.id}/submissions`
              : `/admin/challenges/${challenge.id}/submissions?status=${f}`;
          return (
            <Link
              key={f}
              href={href}
              className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
                active
                  ? "border-spark/30 bg-spark/10 text-spark-ink"
                  : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              {f}
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">No submissions yet.</p>
        </Card>
      ) : (
        <Card className="mt-6 !p-0 overflow-hidden">
          <ul className="divide-y divide-line">
            {rows.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/admin/challenges/${challenge.id}/submissions/${s.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-4 hover:bg-wash"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-ink">
                        {s.name}
                      </span>
                      <StatusBadge status={s.status} />
                      {s.winnerPublic && (
                        <span className="rounded-full bg-spark/15 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-spark-ink">
                          Public
                        </span>
                      )}
                    </div>
                    {s.email && (
                      <p className="mt-0.5 truncate text-xs text-ink-faint">
                        {s.email}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-xs text-ink-faint">
                    {s.payoutCents != null && (
                      <span className="font-mono text-spark-ink">
                        {formatCents(s.payoutCents)}
                      </span>
                    )}
                    <LocalTime value={s.createdAt} mode="datetime-short" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
