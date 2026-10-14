"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import type { Check } from "@/lib/discord-doctor";
import type { Role } from "@/lib/types";
import { runDiscordCheck, type DiscordCheckResult } from "./actions";

const CHECK_DOT: Record<Check["status"], string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  fail: "bg-red-500",
  skip: "bg-ink-faint/40",
};

const ROLE_ABBR: [Role, string][] = [
  ["student", "S"],
  ["mentor", "M"],
  ["admin", "A"],
  ["investor", "I"],
];

/** Live Discord check, on demand only: the page load never calls Discord. */
export function HealthCheck() {
  const [result, setResult] = useState<DiscordCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run() {
    setError(null);
    start(async () => {
      try {
        setResult(await runDiscordCheck());
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  const report = result?.report ?? null;
  const summary = report
    ? report.counts.fail > 0
      ? `${report.counts.fail} failing`
      : report.counts.warn > 0
        ? `${report.counts.warn} warning${report.counts.warn === 1 ? "" : "s"}`
        : "All checks passing"
    : null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Health check
        </h2>
        <Button type="button" variant="secondary" disabled={pending} onClick={run}>
          {pending ? "Checking…" : result ? "Run again" : "Run check"}
        </Button>
      </div>

      {error && (
        <p className="mt-3 text-xs text-red-700 dark:text-red-300">{error}</p>
      )}

      {result && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Linked accounts" value={String(result.linked)} />
            <Stat
              label="Enrolled · linked"
              value={
                result.enrolled > 0
                  ? `${result.enrolledLinked}/${result.enrolled} (${Math.round((result.enrolledLinked / result.enrolled) * 100)}%)`
                  : "—"
              }
            />
            <Stat
              label="Server members"
              value={report?.memberCount == null ? "—" : String(report.memberCount)}
            />
            <Stat
              label="Linked by role"
              value={ROLE_ABBR.map(([k, abbr]) => `${abbr}:${result.byRole[k] ?? 0}`).join(" · ")}
            />
          </div>

          {report === null ? (
            <p className="mt-4 text-xs text-red-700 dark:text-red-300">
              The check failed to run. See the server logs.
            </p>
          ) : (
            <>
              <p className="mt-4 text-xs text-ink-faint">
                {summary}
                {report.guildName ? ` · ${report.guildName}` : ""} ·{" "}
                <LocalTime value={report.ranAt} mode="datetime" />
              </p>
              <ul className="mt-3 space-y-3 text-sm">
                {report.checks.map((c) => (
                  <li key={c.id} className="flex items-start gap-3">
                    <span
                      className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${CHECK_DOT[c.status]}`}
                    />
                    <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      <p className="font-medium text-ink">{c.label}</p>
                      <p className="text-xs text-ink-faint">{c.detail}</p>
                      {c.remedy && (
                        <p className="mt-1 text-xs text-amber-700 dark:text-amber-200">
                          Fix: {c.remedy}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-wash p-3">
      <p className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</p>
      <p className="mt-1 text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}
