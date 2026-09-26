import Link from "next/link";
import { Download } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { formatCents, sanitizeQuestions, type ChallengeQuestion } from "@/lib/challenges";

export const metadata = { title: "Submissions · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

const FILTERS = [
  ["all", "All submitted"],
  ["submitted", "New"],
  ["shortlisted", "Shortlisted"],
  ["funded", "Winners"],
  ["rejected", "Not selected"],
  ["draft", "Drafts"],
] as const;

const STATUS_LABEL: Record<string, string> = {
  funded: "winner",
  rejected: "not selected",
};

/** The first short answer on the form — usually the project name. */
function headlineAnswer(questions: ChallengeQuestion[], answers: Record<string, unknown>): string {
  for (const q of questions) {
    if (q.type !== "short_text") continue;
    const v = answers?.[q.id];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export default async function ChallengeSubmissionsPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ id }, { status }] = await Promise.all([props.params, props.searchParams]);
  await requirePermission("challenges.manage");
  const admin = createAdminClient();
  const filter = status ?? "all";

  let q = admin
    .from("challenge_submissions")
    .select(
      "id, status, created_at, submitted_at, updated_at, payout_amount_cents, award_label, winner_public, answers, questions_snapshot, applicant:profiles!challenge_submissions_user_id_fkey(full_name, email)",
    )
    .eq("challenge_id", id)
    .order("submitted_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false });
  if (filter === "all") q = q.neq("status", "draft");
  else q = q.eq("status", filter);
  const { data: subs } = await q;

  const rows = (subs ?? []).map((s: any) => {
    const applicant = Array.isArray(s.applicant) ? s.applicant[0] : s.applicant;
    return {
      id: s.id as string,
      status: s.status as string,
      at: (s.submitted_at ?? s.updated_at ?? s.created_at) as string,
      payoutCents: s.payout_amount_cents as number | null,
      awardLabel: s.award_label as string | null,
      winnerPublic: s.winner_public as boolean,
      name: applicant?.full_name ?? applicant?.email ?? "Entrant",
      email: applicant?.email ?? null,
      project: headlineAnswer(sanitizeQuestions(s.questions_snapshot), s.answers ?? {}),
    };
  });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map(([f, label]) => {
            const active = filter === f;
            return (
              <Link
                key={f}
                href={f === "all" ? `/admin/challenges/${id}/submissions` : `/admin/challenges/${id}/submissions?status=${f}`}
                className={`rounded-full border px-3 py-1 text-xs ${
                  active ? "border-phosphor/40 bg-phosphor/10 text-phosphor-ink" : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
        <a
          href={`/api/admin/export/challenge-submissions?id=${id}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink-soft hover:border-ink/30 hover:text-ink"
        >
          <Download className="h-3.5 w-3.5" /> Export CSV
        </a>
      </div>

      {rows.length === 0 ? (
        <Card className="mt-5">
          <p className="text-sm text-ink-soft">
            {filter === "draft" ? "No drafts in progress." : "Nothing here yet."}
          </p>
        </Card>
      ) : (
        <Card className="mt-5 !p-0 overflow-hidden">
          <ul className="divide-y divide-line">
            {rows.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/admin/challenges/${id}/submissions/${s.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-4 hover:bg-wash"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-ink">{s.project || s.name}</span>
                      <StatusBadge status={STATUS_LABEL[s.status] ?? s.status} />
                      {s.winnerPublic && (
                        <span className="rounded-full bg-phosphor/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-phosphor-ink">
                          Public
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-ink-faint">
                      {s.project ? `${s.name} · ` : ""}
                      {s.email}
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-ink-faint">
                    {(s.awardLabel || s.payoutCents != null) && (
                      <span className="max-w-[14rem] truncate font-mono text-phosphor-ink">
                        {s.awardLabel ?? formatCents(s.payoutCents)}
                      </span>
                    )}
                    <span>
                      {s.status === "draft" ? "edited " : ""}
                      <LocalTime value={s.at} mode="datetime-short" />
                    </span>
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
