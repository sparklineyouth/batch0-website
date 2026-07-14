import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import {
  OVERAGE_INPUT_PER_M_CENTS,
  OVERAGE_OUTPUT_PER_M_CENTS,
  MONTHLY_HARD_CAP_CENTS,
  thisMonthStartISODate,
} from "@/lib/ai/pricing";
import { Sparkles, Coins, Users, Activity } from "lucide-react";

export const metadata = { title: "AI usage · Admin" };

// Always fetch fresh — admins look at this to spot a runaway user before
// they hit the hard cap, so cached data defeats the point.
export const dynamic = "force-dynamic";

function fmtMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Raw model cost (what we actually owe Anthropic) — distinct from what
// we bill students. We charge ~2× to cover gateway overhead + margin,
// so the "true cost" tile lets admins see the underlying spend.
function rawCostCents(input: number, output: number) {
  return Math.ceil(
    (input * (OVERAGE_INPUT_PER_M_CENTS / 2)) / 1_000_000 +
      (output * (OVERAGE_OUTPUT_PER_M_CENTS / 2)) / 1_000_000,
  );
}

export default async function AdminAiUsagePage() {
  const admin = createAdminClient();
  const monthStart = thisMonthStartISODate();

  // Last 6 months of monthly rollup + per-user current month + last-30-day
  // daily message volume. Each query is independent so they go in parallel.
  const sixMonthsAgo = (() => {
    const d = new Date(monthStart);
    d.setUTCMonth(d.getUTCMonth() - 5);
    return d.toISOString().slice(0, 10);
  })();
  const thirtyDaysAgo = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 29);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  })();

  const [
    { data: monthlyRows },
    { data: userRows },
    { data: messageRows },
    { count: chatUsers },
  ] = await Promise.all([
    admin
      .from("ai_usage")
      .select(
        "month_start, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, billed_cents",
      )
      .gte("month_start", sixMonthsAgo)
      .order("month_start", { ascending: true }),
    admin
      .from("ai_usage")
      .select(
        "user_id, input_tokens, output_tokens, cache_read_tokens, billed_cents, profile:profiles!ai_usage_user_id_fkey(email, full_name)",
      )
      .eq("month_start", monthStart)
      .order("input_tokens", { ascending: false })
      .limit(50),
    admin
      .from("ai_messages")
      .select("created_at, input_tokens, output_tokens")
      .gte("created_at", thirtyDaysAgo),
    admin
      .from("ai_usage")
      .select("user_id", { count: "exact", head: true })
      .eq("month_start", monthStart),
  ]);

  // Aggregate monthly rollup into a per-month chart series. Some months
  // might have no rows at all (no usage); we fill those so the bar chart
  // doesn't skip months visually.
  type MonthBucket = {
    key: string;
    label: string;
    input: number;
    output: number;
    billed: number;
  };
  const months: MonthBucket[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(monthStart);
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = d.toISOString().slice(0, 10);
    months.push({
      key,
      label: d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      input: 0,
      output: 0,
      billed: 0,
    });
  }
  for (const row of monthlyRows ?? []) {
    const b = months.find((m) => m.key === row.month_start);
    if (!b) continue;
    b.input += row.input_tokens ?? 0;
    b.output += row.output_tokens ?? 0;
    b.billed += row.billed_cents ?? 0;
  }

  // Daily series, last 30 days. ai_messages can have a lot of rows so we
  // pull only the columns we need and aggregate client-side. For a single
  // accelerator cohort this is fine — re-evaluate if it gets slow.
  const dayBuckets = new Map<string, { input: number; output: number }>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const k = d.toISOString().slice(0, 10);
    dayBuckets.set(k, { input: 0, output: 0 });
  }
  for (const m of messageRows ?? []) {
    const k = (m.created_at as string).slice(0, 10);
    const b = dayBuckets.get(k);
    if (!b) continue;
    b.input += m.input_tokens ?? 0;
    b.output += m.output_tokens ?? 0;
  }
  const daySeries = Array.from(dayBuckets.entries()).map(([k, v]) => ({
    key: k,
    input: v.input,
    output: v.output,
    total: v.input + v.output,
  }));
  const maxDayTotal = Math.max(1, ...daySeries.map((d) => d.total));

  // Top-line numbers for the hero strip.
  const currentMonth = months[months.length - 1];
  const monthRawCostCents = rawCostCents(currentMonth.input, currentMonth.output);
  const totalActiveUsers = chatUsers ?? 0;
  const overCapUsers =
    userRows?.filter((r: any) => (r.billed_cents ?? 0) >= MONTHLY_HARD_CAP_CENTS)
      .length ?? 0;
  const maxMonthBilled = Math.max(1, ...months.map((m) => m.billed));

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">AI usage</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Token consumption and overage billing across all users. Refreshes
            on every page load.
          </p>
        </div>
        <Link
          href="/admin/audit?action=application.ai_screened"
          className="text-xs text-phosphor-ink hover:underline"
        >
          Recent AI screenings →
        </Link>
      </div>

      <section className="mt-6 grid gap-3 md:grid-cols-4">
        <Tile
          icon={Coins}
          label="Billed this month"
          value={fmtMoney(currentMonth.billed)}
          hint={`raw cost ~${fmtMoney(monthRawCostCents)}`}
        />
        <Tile
          icon={Sparkles}
          label="Tokens this month"
          value={fmtTokens(currentMonth.input + currentMonth.output)}
          hint={`in ${fmtTokens(currentMonth.input)} · out ${fmtTokens(
            currentMonth.output,
          )}`}
        />
        <Tile
          icon={Users}
          label="Active users (month)"
          value={String(totalActiveUsers)}
          hint={
            overCapUsers > 0
              ? `${overCapUsers} at hard cap (${fmtMoney(MONTHLY_HARD_CAP_CENTS)})`
              : "none at hard cap"
          }
          warn={overCapUsers > 0}
        />
        <Tile
          icon={Activity}
          label="Messages (30d)"
          value={String(messageRows?.length ?? 0)}
          hint={`${daySeries.filter((d) => d.total > 0).length}/30 active days`}
        />
      </section>

      <Card className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Monthly billed overage
        </h2>
        <p className="mt-1 text-xs text-ink-faint">
          What we charged students. Free tier covered the rest.
        </p>
        <div className="mt-6 grid grid-cols-6 items-end gap-3 h-40">
          {months.map((m) => {
            const h = Math.max(2, Math.round((m.billed / maxMonthBilled) * 100));
            const isCurrent = m.key === currentMonth.key;
            return (
              <div key={m.key} className="flex flex-col items-center gap-1.5">
                <div className="text-[10px] tabular-nums text-ink-soft">
                  {m.billed > 0 ? fmtMoney(m.billed) : "—"}
                </div>
                <div
                  className={`w-full rounded-t ${isCurrent ? "bg-phosphor" : "bg-phosphor/40"}`}
                  style={{ height: `${h}%` }}
                />
                <div className="text-[10px] uppercase tracking-wider text-ink-faint">
                  {m.label}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Daily tokens · last 30 days
        </h2>
        <p className="mt-1 text-xs text-ink-faint">
          Input + output combined. Spikes mean someone ran a long session.
        </p>
        <div className="mt-6 flex h-32 items-end gap-[3px]">
          {daySeries.map((d) => {
            const h = Math.max(1, Math.round((d.total / maxDayTotal) * 100));
            return (
              <div
                key={d.key}
                title={`${d.key} · ${fmtTokens(d.total)} tokens`}
                className="flex-1 rounded-t bg-phosphor/60 hover:bg-phosphor transition-colors"
                style={{ height: `${h}%` }}
              />
            );
          })}
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-ink-faint">
          <span>{daySeries[0]?.key}</span>
          <span>today</span>
        </div>
      </Card>

      <Card className="mt-6 !p-0 overflow-hidden">
        <div className="flex items-baseline justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
              Top users this month
            </h2>
            <p className="mt-1 text-xs text-ink-faint">
              Sorted by input tokens. Cap is {fmtMoney(MONTHLY_HARD_CAP_CENTS)} —
              past that, the chat handler refuses further messages.
            </p>
          </div>
        </div>
        {(userRows?.length ?? 0) === 0 ? (
          <p className="p-6 text-sm text-ink-faint">No AI usage yet this month.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
                <th className="px-5 py-3">User</th>
                <th className="px-5 py-3 text-right">Input</th>
                <th className="px-5 py-3 text-right">Output</th>
                <th className="px-5 py-3 text-right">Cache hits</th>
                <th className="px-5 py-3 text-right">Billed</th>
              </tr>
            </thead>
            <tbody>
              {(userRows ?? []).map((r: any) => {
                const atCap = (r.billed_cents ?? 0) >= MONTHLY_HARD_CAP_CENTS;
                const name =
                  r.profile?.full_name ||
                  r.profile?.email ||
                  r.user_id.slice(0, 8);
                return (
                  <tr
                    key={r.user_id}
                    className="border-b border-line last:border-0"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/admin/students?q=${encodeURIComponent(r.profile?.email ?? "")}`}
                        className="text-ink hover:text-phosphor-ink"
                      >
                        {name}
                      </Link>
                      {r.profile?.full_name && r.profile?.email && (
                        <div className="text-[11px] text-ink-faint">
                          {r.profile.email}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink-soft">
                      {fmtTokens(r.input_tokens ?? 0)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink-soft">
                      {fmtTokens(r.output_tokens ?? 0)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink-faint">
                      {fmtTokens(r.cache_read_tokens ?? 0)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      <span
                        className={
                          atCap
                            ? "rounded-full bg-red-500/15 px-2 py-0.5 text-red-700 dark:text-red-300"
                            : (r.billed_cents ?? 0) > 0
                              ? "text-phosphor-ink"
                              : "text-ink-faint"
                        }
                      >
                        {fmtMoney(r.billed_cents ?? 0)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
  warn,
}: {
  icon: any;
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border bg-wash px-4 py-4 ${
        warn ? "border-red-500/30" : "border-line"
      }`}
    >
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
        <Icon className={`h-3.5 w-3.5 ${warn ? "text-red-700 dark:text-red-300" : ""}`} />
        {label}
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tracking-tight ${
          warn ? "text-red-700 dark:text-red-300" : "text-ink"
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-ink-faint">{hint}</div>}
    </div>
  );
}
