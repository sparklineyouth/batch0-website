import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { Card, StatusBadge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { ChallengeRowActions } from "./challenge-row-actions";
import type { ChallengeStatus } from "@/lib/challenges";

export const metadata = { title: "Challenges · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

const FILTERS = ["all", "draft", "active", "closed", "archived"];

export default async function AdminChallengesPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  await requireAdmin();
  const admin = createAdminClient();
  const status = searchParams.status;

  let q = admin
    .from("challenges")
    .select("*, submissions:challenge_submissions(count)")
    .order("created_at", { ascending: false });
  if (status && status !== "all") q = q.eq("status", status);
  const { data: rows } = await q;

  const challenges = (rows ?? []).map((r: any) => ({
    id: r.id as string,
    slug: r.slug as string,
    title: r.title as string,
    status: r.status as ChallengeStatus,
    prizeLabel: (r.prize_label as string) ?? "",
    opensAt: r.opens_at as string | null,
    closesAt: r.closes_at as string | null,
    submissionCount: Array.isArray(r.submissions)
      ? (r.submissions[0]?.count ?? 0)
      : 0,
  }));

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Challenges
          </h1>
          <p className="mt-1 text-sm text-ink-faint">
            Weekly build challenges. The one that&apos;s <em>live</em> shows as a
            marquee on the homepage.
          </p>
        </div>
        <Link href="/admin/challenges/new">
          <Button>New challenge</Button>
        </Link>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = (status ?? "all") === f;
          const href =
            f === "all"
              ? "/admin/challenges"
              : `/admin/challenges?status=${f}`;
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

      {challenges.length === 0 ? (
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            No challenges yet.{" "}
            <Link href="/admin/challenges/new" className="text-spark-ink hover:underline">
              Create your first one
            </Link>
            .
          </p>
        </Card>
      ) : (
        <Card className="mt-6 !p-0 overflow-hidden">
          <ul className="divide-y divide-line">
            {challenges.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/admin/challenges/${c.id}/edit`}
                      className="truncate font-medium text-ink hover:underline"
                    >
                      {c.title}
                    </Link>
                    <StatusBadge status={c.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                    <span className="font-mono">/challenges/{c.slug}</span>
                    {c.prizeLabel && <span>· {c.prizeLabel}</span>}
                    {c.closesAt && (
                      <span>
                        · closes{" "}
                        <LocalTime value={c.closesAt} mode="datetime-short" />
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <Link
                    href={`/admin/challenges/${c.id}/submissions`}
                    className="text-sm text-ink-soft hover:text-ink"
                  >
                    {c.submissionCount}{" "}
                    <span className="text-ink-faint">
                      submission{c.submissionCount === 1 ? "" : "s"}
                    </span>
                  </Link>
                  <ChallengeRowActions id={c.id} status={c.status} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
