import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { ResolveButton } from "./resolve-button";

export const metadata = { title: "At-risk · Admin" };

export default async function InterventionsPage() {
  await requireAdmin();
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("at_risk_interventions")
    .select(
      "id, missed_weeks, reason, resolved_at, week_start, created_at, student:profiles(id, full_name, email)",
    )
    .order("created_at", { ascending: false })
    .limit(200);

  const unresolved = (rows ?? []).filter((r: any) => !r.resolved_at);
  const resolved = (rows ?? []).filter((r: any) => r.resolved_at);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">At-risk students</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Auto-flagged by the Monday cron. Each row represents two consecutive
        weeks without a check-in. Mark resolved once you've reached out or
        booked office hours.
      </p>

      <Card className="mt-6 !p-0">
        <header className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">
          Unresolved ({unresolved.length})
        </header>
        <ul className="divide-y divide-line">
          {unresolved.length === 0 && (
            <li className="px-4 py-6 text-sm text-ink-faint">
              Nobody's on the at-risk list right now. 🎉
            </li>
          )}
          {unresolved.map((r: any) => {
            const s = Array.isArray(r.student) ? r.student[0] : r.student;
            return (
              <li
                key={r.id}
                className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {s?.full_name ?? s?.email ?? "Student"}
                  </p>
                  <p className="text-xs text-ink-soft">
                    {r.reason} · flagged{" "}
                    <LocalTime value={r.created_at} mode="date" />
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    href={`/admin/students/${s?.id}`}
                    className="text-xs text-phosphor-ink hover:underline"
                  >
                    Open →
                  </Link>
                  <ResolveButton id={r.id} />
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {resolved.length > 0 && (
        <Card className="mt-6 !p-0">
          <header className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">
            Resolved (recent {resolved.length})
          </header>
          <ul className="divide-y divide-line">
            {resolved.slice(0, 30).map((r: any) => {
              const s = Array.isArray(r.student) ? r.student[0] : r.student;
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3 opacity-70"
                >
                  <div>
                    <p className="text-sm text-ink-soft">
                      {s?.full_name ?? "Student"}
                    </p>
                    <p className="text-xs text-ink-faint">
                      Resolved{" "}
                      <LocalTime value={r.resolved_at} mode="date" />
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
