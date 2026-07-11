import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { isoWeekStart, mondayOf } from "@/lib/week";
import { thisMonthStartISODate } from "@/lib/ai/pricing";
import {
  Activity,
  Inbox,
  CheckCircle,
  CreditCard,
  Sparkles,
  AlertTriangle,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";

export const metadata = { title: "Pulse · Admin" };
export const dynamic = "force-dynamic";

function fmtMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function pct(num: number, denom: number) {
  if (denom <= 0) return 0;
  return Math.round((num / denom) * 100);
}

function daysAgo(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

// Last 8 ISO weeks, oldest → newest. Each "key" is the Monday ISO date.
function lastNWeeks(n: number) {
  const out: { key: string; label: string; start: Date; end: Date }[] = [];
  const thisMonday = mondayOf(new Date());
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(thisMonday);
    start.setUTCDate(start.getUTCDate() - i * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    out.push({
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
  return out;
}

export default async function PulsePage() {
  const admin = createAdminClient();

  const now = new Date();
  const last7Start = daysAgo(6); // inclusive
  last7Start.setUTCHours(0, 0, 0, 0);
  const prev7Start = daysAgo(13);
  prev7Start.setUTCHours(0, 0, 0, 0);
  const eightWeeks = lastNWeeks(8);
  const eightWeeksStart = eightWeeks[0].start;
  const currentWeekStart = isoWeekStart(now);
  const twoWeeksAgo = (() => {
    const d = new Date(currentWeekStart);
    d.setUTCDate(d.getUTCDate() - 14);
    return d.toISOString().slice(0, 10);
  })();
  const aiMonth = thisMonthStartISODate();

  const [
    { data: recentApps },
    { data: recentPayments },
    { data: weeklyCheckins },
    { data: activeCohorts },
    { count: pendingApps },
    { data: enrolledRows },
    { data: aiUsageRow },
    { data: auditDecisions },
  ] = await Promise.all([
    admin
      .from("applications")
      .select("id, status, created_at, submitted_at")
      .gte("created_at", prev7Start.toISOString()),
    admin
      .from("payments")
      .select("amount_cents, status, created_at")
      .gte("created_at", eightWeeksStart.toISOString())
      .eq("status", "succeeded"),
    admin
      .from("student_checkins")
      .select("user_id, cohort_id, week_start, created_at")
      .gte("week_start", twoWeeksAgo),
    admin
      .from("cohorts")
      .select("id, name, capacity, status, starts_on, ends_on")
      .in("status", ["upcoming", "active"])
      .order("starts_on", { ascending: true }),
    admin
      .from("applications")
      .select("id", { count: "exact", head: true })
      .eq("status", "submitted"),
    admin
      .from("enrollments")
      .select("user_id, cohort_id"),
    admin
      .from("ai_usage")
      .select("input_tokens, output_tokens, billed_cents")
      .eq("month_start", aiMonth),
    admin
      .from("audit_log")
      .select("action, created_at")
      .gte("created_at", prev7Start.toISOString())
      .in("action", ["application.accepted", "application.rejected"]),
  ]);

  // ── Application metrics ─────────────────────────────────────────────────
  const apps7 =
    recentApps?.filter(
      (a: any) => new Date(a.created_at) >= last7Start,
    ).length ?? 0;
  const appsPrev7 =
    recentApps?.filter(
      (a: any) =>
        new Date(a.created_at) >= prev7Start &&
        new Date(a.created_at) < last7Start,
    ).length ?? 0;

  const submissions7 =
    recentApps?.filter(
      (a: any) =>
        a.submitted_at && new Date(a.submitted_at) >= last7Start,
    ).length ?? 0;

  const decisions7 =
    auditDecisions?.filter(
      (a: any) => new Date(a.created_at) >= last7Start,
    ).length ?? 0;

  // ── Revenue metrics ─────────────────────────────────────────────────────
  const rev7 = (recentPayments ?? [])
    .filter((p: any) => new Date(p.created_at) >= last7Start)
    .reduce((s: number, p: any) => s + (p.amount_cents ?? 0), 0);
  const revPrev7 = (recentPayments ?? [])
    .filter(
      (p: any) =>
        new Date(p.created_at) >= prev7Start &&
        new Date(p.created_at) < last7Start,
    )
    .reduce((s: number, p: any) => s + (p.amount_cents ?? 0), 0);

  // ── Weekly bar series ───────────────────────────────────────────────────
  const appsByWeek = eightWeeks.map((w) => ({
    ...w,
    count: (recentApps ?? []).filter(
      (a: any) =>
        new Date(a.created_at) >= w.start && new Date(a.created_at) < w.end,
    ).length,
  }));
  const maxAppsWk = Math.max(1, ...appsByWeek.map((w) => w.count));

  const revByWeek = eightWeeks.map((w) => ({
    ...w,
    cents: (recentPayments ?? [])
      .filter(
        (p: any) =>
          new Date(p.created_at) >= w.start && new Date(p.created_at) < w.end,
      )
      .reduce((s: number, p: any) => s + (p.amount_cents ?? 0), 0),
  }));
  const maxRevWk = Math.max(1, ...revByWeek.map((w) => w.cents));

  // ── Check-in completion ─────────────────────────────────────────────────
  const enrolledUserIds = new Set((enrolledRows ?? []).map((e: any) => e.user_id));
  const enrolledTotal = enrolledUserIds.size;
  const checkedInThisWeek = new Set(
    (weeklyCheckins ?? [])
      .filter((c: any) => c.week_start === currentWeekStart)
      .map((c: any) => c.user_id),
  );
  const checkedInCount = Array.from(checkedInThisWeek).filter((id) =>
    enrolledUserIds.has(id as string),
  ).length;
  const checkinPct = pct(checkedInCount, enrolledTotal);

  // At-risk = enrolled but no check-in in either of the last two ISO weeks.
  // "No check-in" is a leading signal of disengagement.
  const lastWeekKey = (() => {
    const d = new Date(currentWeekStart);
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();
  const recentCheckinUsers = new Set(
    (weeklyCheckins ?? [])
      .filter(
        (c: any) =>
          c.week_start === currentWeekStart || c.week_start === lastWeekKey,
      )
      .map((c: any) => c.user_id),
  );
  const atRiskCount = Array.from(enrolledUserIds).filter(
    (id) => !recentCheckinUsers.has(id as string),
  ).length;

  // ── AI usage rollup ─────────────────────────────────────────────────────
  const aiTotal = {
    input: 0,
    output: 0,
    billed: 0,
    users: aiUsageRow?.length ?? 0,
  };
  for (const r of aiUsageRow ?? []) {
    aiTotal.input += r.input_tokens ?? 0;
    aiTotal.output += r.output_tokens ?? 0;
    aiTotal.billed += r.billed_cents ?? 0;
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-end justify-between gap-3 border-b border-line pb-6">
        <div>
          <p className="text-[11px] font-mono font-medium uppercase tracking-[0.22em] text-spark-ink">
            Pulse
          </p>
          <h1 className="mt-3 font-display text-4xl md:text-5xl font-bold tracking-[-0.02em] text-ink">
            How the program is moving.
          </h1>
          <p className="mt-3 max-w-xl text-[15px] text-ink-soft leading-relaxed">
            Weekly snapshot: applications, revenue, check-in health, AI spend.
            Everything you'd want to glance at on a Monday morning.
          </p>
        </div>
      </div>

      {/* Week-over-week deltas */}
      <section className="mt-6 grid gap-3 md:grid-cols-4">
        <Delta
          icon={Inbox}
          label="Applications · 7d"
          current={apps7}
          prior={appsPrev7}
          format={(n) => String(n)}
          href="/admin/applications"
        />
        <Delta
          icon={CreditCard}
          label="Revenue · 7d"
          current={rev7}
          prior={revPrev7}
          format={fmtMoney}
          href="/admin/payments"
        />
        <Delta
          icon={CheckCircle}
          label="Decisions · 7d"
          current={decisions7}
          prior={null}
          format={(n) => String(n)}
          href="/admin/audit?action=application.accepted"
          hint={`${submissions7} new submissions`}
        />
        <Delta
          icon={Sparkles}
          label="AI billed · MTD"
          current={aiTotal.billed}
          prior={null}
          format={fmtMoney}
          href="/admin/ai-usage"
          hint={`${aiTotal.users} users active`}
        />
      </section>

      {/* Inbox bar */}
      <section className="mt-6">
        <div className="grid gap-3 md:grid-cols-3">
          <InboxRow
            label="Pending review"
            count={pendingApps ?? 0}
            href="/admin/applications?status=submitted"
            tone={(pendingApps ?? 0) > 0 ? "spark" : "muted"}
            icon={Inbox}
          />
          <InboxRow
            label="At-risk students"
            count={atRiskCount}
            href="/admin/students"
            tone={atRiskCount > 0 ? "warn" : "muted"}
            icon={AlertTriangle}
            hint="No check-in for 2+ weeks"
          />
          <InboxRow
            label="Check-ins · this week"
            count={enrolledTotal === 0 ? 0 : checkinPct}
            suffix={enrolledTotal === 0 ? "" : "%"}
            href="/admin/students"
            tone={
              enrolledTotal === 0
                ? "muted"
                : checkinPct >= 70
                  ? "ok"
                  : checkinPct >= 40
                    ? "warn"
                    : "bad"
            }
            icon={CheckCircle}
            hint={`${checkedInCount} of ${enrolledTotal} enrolled`}
          />
        </div>
      </section>

      {/* Trend cards */}
      <section className="mt-8 grid gap-6 md:grid-cols-2">
        <Card>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
            Applications · 8 weeks
          </h2>
          <p className="mt-1 text-xs text-ink-faint">
            New applications received per ISO week.
          </p>
          <div className="mt-6 grid grid-cols-8 items-end gap-2 h-32">
            {appsByWeek.map((w) => (
              <div key={w.key} className="flex flex-col items-center gap-1">
                <div className="text-[10px] tabular-nums text-ink-soft">
                  {w.count || ""}
                </div>
                <div
                  className="w-full rounded-t bg-spark/50"
                  style={{
                    height: `${Math.max(2, Math.round((w.count / maxAppsWk) * 100))}%`,
                  }}
                />
                <div className="text-[9px] tabular-nums text-ink-faint">
                  {w.label}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
            Revenue · 8 weeks
          </h2>
          <p className="mt-1 text-xs text-ink-faint">
            Succeeded payments only. Excludes fees & fines.
          </p>
          <div className="mt-6 grid grid-cols-8 items-end gap-2 h-32">
            {revByWeek.map((w) => (
              <div key={w.key} className="flex flex-col items-center gap-1">
                <div className="text-[10px] tabular-nums text-ink-soft">
                  {w.cents > 0 ? fmtMoney(w.cents) : ""}
                </div>
                <div
                  className="w-full rounded-t bg-emerald-400/60"
                  style={{
                    height: `${Math.max(2, Math.round((w.cents / maxRevWk) * 100))}%`,
                  }}
                />
                <div className="text-[9px] tabular-nums text-ink-faint">
                  {w.label}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </section>

      {/* Cohorts row */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Cohorts in flight
        </h2>
        <div className="mt-3 divide-y divide-line rounded-2xl border border-line bg-wash">
          {(activeCohorts?.length ?? 0) === 0 ? (
            <p className="p-6 text-sm text-ink-faint">
              No upcoming or active cohorts.
            </p>
          ) : (
            (activeCohorts ?? []).map((c: any) => {
              const enrolled = (enrolledRows ?? []).filter(
                (e: any) => e.cohort_id === c.id,
              ).length;
              const capPct = pct(enrolled, c.capacity ?? 0);
              return (
                <Link
                  key={c.id}
                  href={`/admin/cohorts`}
                  className="group flex items-center gap-4 px-5 py-4 hover:bg-wash"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-semibold text-ink group-hover:text-spark-ink">
                        {c.name}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                          c.status === "active"
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : "bg-blue-500/15 text-blue-700 dark:text-blue-300"
                        }`}
                      >
                        {c.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-faint">
                      {c.starts_on} → {c.ends_on ?? "tbd"}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-sm tabular-nums text-ink-soft">
                      {enrolled} / {c.capacity ?? "?"}
                    </div>
                    <div className="text-[11px] text-ink-faint">
                      {c.capacity ? `${capPct}% full` : ""}
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-ink-faint group-hover:text-ink" />
                </Link>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function Delta({
  icon: Icon,
  label,
  current,
  prior,
  format,
  href,
  hint,
}: {
  icon: any;
  label: string;
  current: number;
  prior: number | null;
  format: (n: number) => string;
  href?: string;
  hint?: string;
}) {
  let trend: "up" | "down" | "flat" | "none" = "none";
  let deltaText = "";
  if (prior != null) {
    const diff = current - prior;
    if (diff > 0) trend = "up";
    else if (diff < 0) trend = "down";
    else trend = "flat";
    if (prior === 0) {
      deltaText = current > 0 ? "new" : "flat";
    } else {
      const ratio = diff / prior;
      deltaText = `${ratio > 0 ? "+" : ""}${Math.round(ratio * 100)}%`;
    }
  }
  const TrendIcon =
    trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendColor =
    trend === "up"
      ? "text-emerald-700 dark:text-emerald-300"
      : trend === "down"
        ? "text-red-700 dark:text-red-300"
        : "text-ink-faint";

  const body = (
    <>
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <div className="text-2xl font-semibold tracking-tight text-ink">
          {format(current)}
        </div>
        {prior != null && trend !== "none" && (
          <span className={`inline-flex items-center gap-0.5 text-xs ${trendColor}`}>
            <TrendIcon className="h-3 w-3" />
            {deltaText}
          </span>
        )}
      </div>
      {hint && <div className="mt-1 text-[11px] text-ink-faint">{hint}</div>}
    </>
  );

  const classes =
    "block rounded-xl border border-line bg-wash px-4 py-4 hover:border-ink/30";
  return href ? (
    <Link href={href} className={classes}>
      {body}
    </Link>
  ) : (
    <div className={classes}>{body}</div>
  );
}

function InboxRow({
  icon: Icon,
  label,
  count,
  suffix,
  href,
  tone,
  hint,
}: {
  icon: any;
  label: string;
  count: number;
  suffix?: string;
  href: string;
  tone: "spark" | "warn" | "muted" | "ok" | "bad";
  hint?: string;
}) {
  const colors = {
    spark: "text-spark-ink",
    warn: "text-amber-700 dark:text-amber-300",
    muted: "text-ink-faint",
    ok: "text-emerald-700 dark:text-emerald-300",
    bad: "text-red-700 dark:text-red-300",
  } as const;
  return (
    <Link
      href={href}
      className="press group flex items-center gap-4 rounded-xl border border-line bg-wash px-5 py-4 hover:border-ink/30 hover:bg-wash"
    >
      <Icon className={`h-5 w-5 shrink-0 ${colors[tone]}`} />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
          {label}
        </p>
        <p
          className={`mt-1 text-3xl font-semibold tracking-tight ${colors[tone]}`}
        >
          {count}
          {suffix}
        </p>
        {hint && <p className="mt-0.5 text-[11px] text-ink-faint">{hint}</p>}
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-ink-faint group-hover:text-ink" />
    </Link>
  );
}
