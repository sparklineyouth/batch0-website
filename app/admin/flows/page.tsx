import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { FLOW_STAGES } from "@/lib/flows";
import { Plus } from "lucide-react";

export const metadata = { title: "Pre-cohort flows · Admin" };

const STATUS_STYLES: Record<string, string> = {
  published:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  draft: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  archived: "border-line bg-wash text-ink-faint",
};

export default async function AdminFlowsPage() {
  const admin = createAdminClient();
  const { data: flows } = await admin
    .from("flows")
    .select("*, cohort:cohorts(name), steps:flow_steps(count)")
    .order("stage")
    .order("sort_order")
    .order("title");

  const stageLabel = (v: string) =>
    FLOW_STAGES.find((s) => s.value === v)?.label ?? v;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Pre-cohort flows
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            "Before One" — interactive, personalized experiences (diagnostics,
            challenges, guided worksheets) shown to accepted students on the
            Resources page. Steps can branch on a student's answers, so one
            flow can route different founders down different paths.
          </p>
        </div>
        <Link
          href="/admin/flows/new"
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-phosphor px-4 text-sm font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          <Plus className="h-4 w-4" /> New flow
        </Link>
      </div>

      <Card className="mt-6 !p-0 overflow-hidden">
        {(flows?.length ?? 0) === 0 ? (
          <p className="p-6 text-sm text-ink-soft">
            No flows yet. Build your first — a founder diagnostic, a 7-day
            challenge, or a guided worksheet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
                <th className="px-5 py-3">Title</th>
                <th className="px-5 py-3">Stage</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Steps</th>
                <th className="px-5 py-3">Cohort</th>
                <th className="px-5 py-3">Updated</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {(flows ?? []).map((f: any) => {
                const cohort = Array.isArray(f.cohort) ? f.cohort[0] : f.cohort;
                const stepCount = Array.isArray(f.steps)
                  ? (f.steps[0]?.count ?? 0)
                  : 0;
                return (
                  <tr
                    key={f.id}
                    className="border-b border-line last:border-0 hover:bg-wash"
                  >
                    <td className="px-5 py-3 text-ink">
                      {f.title}
                      <span className="ml-2 font-mono text-[11px] text-ink-faint">
                        /{f.slug}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-ink-soft">
                      {stageLabel(f.stage)}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize ${STATUS_STYLES[f.status] ?? STATUS_STYLES.archived}`}
                      >
                        {f.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-ink-soft">{stepCount}</td>
                    <td className="px-5 py-3 text-ink-soft">
                      {cohort?.name ?? (
                        <span className="text-ink-faint">All</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-ink-faint">
                      <LocalTime value={f.updated_at} mode="date" />
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/admin/flows/${f.id}`}
                        className="text-xs text-phosphor-ink hover:underline"
                      >
                        Edit →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <p className="mt-6 text-xs text-ink-faint">
        Static files and links live in{" "}
        <Link href="/admin/resources" className="underline">
          Resources
        </Link>
        . Flows are the interactive layer on top.
      </p>
    </div>
  );
}
