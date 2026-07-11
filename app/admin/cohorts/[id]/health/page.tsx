import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { isoWeekStart, mondayOf } from "@/lib/week";
import {
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  Activity,
  Sparkles,
  UserX,
} from "lucide-react";

export const metadata = { title: "Cohort health · Admin" };
export const dynamic = "force-dynamic";

const WEEKS_TO_SHOW = 6;

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

type RiskLevel = "ok" | "watch" | "at_risk";

function classifyRisk(
  checkinsInRange: number,
  weeksInRange: number,
  hasTeam: boolean,
): RiskLevel {
  // "at risk" = missed the last 2 weeks in a row (or all weeks if we
  // only have <2 weeks of history). "watch" = missing the current week
  // OR has no team. Everyone else is "ok". The thresholds are
  // intentionally generous — false positives turn a check-in panel into
  // a guilt trip the program doesn't want.
  if (weeksInRange === 0) return "ok";
  const expected = Math.min(weeksInRange, WEEKS_TO_SHOW);
  if (expected >= 2 && checkinsInRange === 0) return "at_risk";
  const coverage = checkinsInRange / expected;
  if (coverage < 0.5 || !hasTeam) return "watch";
  return "ok";
}

export default async function CohortHealthPage({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();

  // Build the last N ISO-week buckets so we can render a heatmap row
  // even for students with zero check-ins.
  const weeks: { key: string; label: string; start: Date; end: Date }[] = [];
  const thisMonday = mondayOf(new Date());
  for (let i = WEEKS_TO_SHOW - 1; i >= 0; i--) {
    const start = new Date(thisMonday);
    start.setUTCDate(start.getUTCDate() - i * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    weeks.push({
      key: start.toISOString().slice(0, 10),
      label: start.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
      start,
      end,
    });
  }
  const oldestWeekKey = weeks[0].key;
  const currentWeekKey = isoWeekStart(new Date());

  const [{ data: cohort }, { data: enrollments }] = await Promise.all([
    admin
      .from("cohorts")
      .select("id, name, starts_on, ends_on, capacity, status, cohort_number")
      .eq("id", params.id)
      .maybeSingle(),
    admin
      .from("enrollments")
      .select(
        "user_id, enrolled_at, profile:profiles!enrollments_user_id_fkey(id, email, full_name)",
      )
      .eq("cohort_id", params.id),
  ]);

  if (!cohort) notFound();

  const userIds = (enrollments ?? []).map((e: any) => e.user_id);
  if (userIds.length === 0) {
    return (
      <div className="mx-auto max-w-6xl">
        <Header cohort={cohort} totalStudents={0} />
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            No students are enrolled in this cohort yet.
          </p>
        </Card>
      </div>
    );
  }

  // Pull the windowed data per student in parallel. Each is a single
  // PostgREST query scoped to the cohort + window, so even with 24
  // enrolled students the total cost is one query.
  const [
    { data: checkins },
    { data: teamMembers },
    { data: aiUsage },
  ] = await Promise.all([
    admin
      .from("student_checkins")
      .select("user_id, week_start, created_at")
      .in("user_id", userIds)
      .gte("week_start", oldestWeekKey),
    admin
      .from("team_members")
      .select(
        "user_id, team:teams!team_members_team_id_fkey(id, name, cohort_id)",
      )
      .in("user_id", userIds),
    admin
      .from("ai_usage")
      .select("user_id, input_tokens, output_tokens, billed_cents, month_start")
      .in("user_id", userIds)
      .order("month_start", { ascending: false }),
  ]);

  // Index everything by user_id for O(1) row build below.
  const checkinByUser = new Map<string, Set<string>>();
  for (const c of checkins ?? []) {
    const set = checkinByUser.get(c.user_id) ?? new Set<string>();
    set.add(c.week_start);
    checkinByUser.set(c.user_id, set);
  }

  const teamByUser = new Map<string, { id: string; name: string }>();
  for (const tm of teamMembers ?? []) {
    const team = Array.isArray(tm.team) ? tm.team[0] : tm.team;
    if (team && team.cohort_id === params.id) {
      teamByUser.set(tm.user_id, { id: team.id, name: team.name });
    }
  }

  // Roll AI rows up to a single total per user — we don't care which
  // month it landed in for the health panel, just the headline number.
  const aiByUser = new Map<
    string,
    { tokens: number; billed: number; lastMonth: string | null }
  >();
  for (const a of aiUsage ?? []) {
    const cur = aiByUser.get(a.user_id) ?? {
      tokens: 0,
      billed: 0,
      lastMonth: null,
    };
    cur.tokens += (a.input_tokens ?? 0) + (a.output_tokens ?? 0);
    cur.billed += a.billed_cents ?? 0;
    if (!cur.lastMonth || a.month_start > cur.lastMonth) {
      cur.lastMonth = a.month_start;
    }
    aiByUser.set(a.user_id, cur);
  }

  type StudentRow = {
    userId: string;
    name: string;
    email: string;
    teamName: string | null;
    enrolledAt: string;
    checkinWeeks: string[];
    risk: RiskLevel;
    ai: { tokens: number; billed: number; lastMonth: string | null };
  };

  const rows: StudentRow[] = (enrollments ?? []).map((e: any) => {
    const profile = Array.isArray(e.profile) ? e.profile[0] : e.profile;
    const checkinSet = checkinByUser.get(e.user_id) ?? new Set<string>();
    const checkinsInRange = weeks.filter((w) => checkinSet.has(w.key)).length;
    const team = teamByUser.get(e.user_id) ?? null;
    return {
      userId: e.user_id,
      name: profile?.full_name || profile?.email || e.user_id.slice(0, 8),
      email: profile?.email ?? "",
      teamName: team?.name ?? null,
      enrolledAt: e.enrolled_at,
      checkinWeeks: Array.from(checkinSet),
      risk: classifyRisk(checkinsInRange, weeks.length, Boolean(team)),
      ai: aiByUser.get(e.user_id) ?? { tokens: 0, billed: 0, lastMonth: null },
    };
  });

  // Sort: at-risk first, then watch, then ok. Within each band by name.
  const riskOrder: Record<RiskLevel, number> = {
    at_risk: 0,
    watch: 1,
    ok: 2,
  };
  rows.sort(
    (a, b) =>
      riskOrder[a.risk] - riskOrder[b.risk] || a.name.localeCompare(b.name),
  );

  const summary = {
    total: rows.length,
    atRisk: rows.filter((r) => r.risk === "at_risk").length,
    watch: rows.filter((r) => r.risk === "watch").length,
    ok: rows.filter((r) => r.risk === "ok").length,
    noTeam: rows.filter((r) => !r.teamName).length,
    thisWeekCheckins: rows.filter((r) =>
      r.checkinWeeks.includes(currentWeekKey),
    ).length,
  };

  return (
    <div className="mx-auto max-w-6xl">
      <Header cohort={cohort} totalStudents={summary.total} />

      <section className="mt-6 grid gap-3 md:grid-cols-4">
        <SummaryTile
          icon={AlertTriangle}
          label="At risk"
          value={summary.atRisk}
          tone={summary.atRisk > 0 ? "bad" : "muted"}
          hint="No check-in for 2+ weeks"
        />
        <SummaryTile
          icon={CheckCircle2}
          label={`Checked in · ${weeks[weeks.length - 1].label}`}
          value={summary.thisWeekCheckins}
          tone={
            summary.total === 0
              ? "muted"
              : summary.thisWeekCheckins / summary.total >= 0.7
                ? "ok"
                : summary.thisWeekCheckins / summary.total >= 0.4
                  ? "warn"
                  : "bad"
          }
          hint={`of ${summary.total} enrolled`}
        />
        <SummaryTile
          icon={UserX}
          label="No team yet"
          value={summary.noTeam}
          tone={summary.noTeam > 0 ? "warn" : "ok"}
        />
        <SummaryTile
          icon={Activity}
          label="Watch list"
          value={summary.watch}
          tone={summary.watch > 0 ? "warn" : "muted"}
          hint="Partial check-ins or no team"
        />
      </section>

      <Card className="mt-6 !p-0 overflow-hidden">
        <div className="border-b border-line bg-wash px-5 py-3 text-xs font-mono uppercase tracking-wider text-ink-faint">
          Per-student health · {WEEKS_TO_SHOW}-week check-in heatmap
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-wash text-left text-xs font-mono uppercase tracking-wider text-ink-faint">
              <th className="px-5 py-3">Student</th>
              <th className="px-5 py-3">Team</th>
              {weeks.map((w) => (
                <th
                  key={w.key}
                  className="px-1 py-3 text-center text-[9px] tabular-nums"
                >
                  {w.label}
                </th>
              ))}
              <th className="px-5 py-3 text-right">AI · MTD</th>
              <th className="px-5 py-3">Risk</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.userId}
                className="border-b border-line last:border-0 hover:bg-wash"
              >
                <td className="px-5 py-3">
                  <Link
                    href={`/admin/students/${r.userId}`}
                    className="text-ink hover:text-spark-ink"
                  >
                    {r.name}
                  </Link>
                  {r.email && r.email !== r.name && (
                    <div className="text-[11px] text-ink-faint">{r.email}</div>
                  )}
                </td>
                <td className="px-5 py-3 text-ink-soft">
                  {r.teamName ?? <span className="text-red-700 dark:text-red-300">—</span>}
                </td>
                {weeks.map((w) => {
                  const checked = r.checkinWeeks.includes(w.key);
                  return (
                    <td key={w.key} className="px-1 py-3 text-center">
                      <span
                        title={`Week of ${w.label} — ${checked ? "checked in" : "no check-in"}`}
                        className={`inline-block h-4 w-4 rounded ${
                          checked
                            ? "bg-emerald-500/70"
                            : "bg-line"
                        }`}
                      />
                    </td>
                  );
                })}
                <td className="px-5 py-3 text-right tabular-nums text-ink-soft">
                  {r.ai.tokens > 0 ? (
                    <>
                      {fmtTokens(r.ai.tokens)}
                      {r.ai.billed > 0 && (
                        <span className="ml-1 text-[10px] text-spark-ink">
                          ${(r.ai.billed / 100).toFixed(2)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="px-5 py-3">
                  <RiskBadge risk={r.risk} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <p className="mt-3 text-[11px] text-ink-faint">
        Health heuristics are intentionally generous: at-risk means two
        consecutive missed weeks of check-ins. Empty heatmap cells are not
        proof of disengagement on their own.
      </p>
    </div>
  );
}

function Header({
  cohort,
  totalStudents,
}: {
  cohort: any;
  totalStudents: number;
}) {
  return (
    <>
      <Link
        href="/admin/cohorts"
        className="inline-flex items-center gap-1.5 text-sm text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All cohorts
      </Link>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-mono font-medium uppercase tracking-[0.22em] text-spark-ink">
            Cohort health
          </p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            {cohort.name}
          </h1>
          <p className="mt-1 text-sm text-ink-soft tabular-nums">
            {cohort.starts_on ?? "—"} → {cohort.ends_on ?? "—"} ·{" "}
            {totalStudents} enrolled
          </p>
        </div>
        <div className="text-right">
          <Link
            href={`/admin/cohorts`}
            className="text-xs text-spark-ink hover:underline"
          >
            Edit cohort →
          </Link>
        </div>
      </div>
    </>
  );
}

function SummaryTile({
  icon: Icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: any;
  label: string;
  value: number;
  tone: "ok" | "warn" | "bad" | "muted";
  hint?: string;
}) {
  const colors = {
    ok: "text-emerald-700 dark:text-emerald-300",
    warn: "text-amber-700 dark:text-amber-300",
    bad: "text-red-700 dark:text-red-300",
    muted: "text-ink-soft",
  } as const;
  return (
    <div className="rounded-xl border border-line bg-wash px-4 py-4">
      <div className="flex items-center gap-2 text-[10px] font-mono font-medium uppercase tracking-[0.2em] text-ink-faint">
        <Icon className={`h-3.5 w-3.5 ${colors[tone]}`} />
        {label}
      </div>
      <div className={`mt-2 text-2xl font-semibold tracking-tight tabular-nums ${colors[tone]}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-ink-faint">{hint}</div>}
    </div>
  );
}

function RiskBadge({ risk }: { risk: RiskLevel }) {
  const config = {
    at_risk: { label: "At risk", cls: "bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300" },
    watch: { label: "Watch", cls: "bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300" },
    ok: { label: "OK", cls: "bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300" },
  } as const;
  const { label, cls } = config[risk];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${cls}`}
    >
      {label}
    </span>
  );
}
