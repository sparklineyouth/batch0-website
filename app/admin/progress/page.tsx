import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { Meter } from "@/components/admin/charts";
import { getRosterProgress, type RosterProgress } from "@/lib/progress";
import { BookOpen, Sparkles, FolderOpen, ArrowRight, Users } from "lucide-react";

export const metadata = { title: "Progress · Admin" };
export const dynamic = "force-dynamic";

const AREA_ICON = {
  course: BookOpen,
  flow: Sparkles,
  resource: FolderOpen,
  challenge: Sparkles,
  assignment: BookOpen,
} as const;

/**
 * Where every student actually is.
 *
 * Sorted by how long they've been idle, longest first, because the question
 * this page exists to answer is "who has stalled?" — not "who is doing well".
 * A roster sorted alphabetically buries exactly the rows worth acting on.
 */
export default async function AdminProgressPage({
  searchParams,
}: {
  searchParams: { cohort?: string };
}) {
  const admin = createAdminClient();

  const [{ data: cohorts }, { data: enrollments }] = await Promise.all([
    admin
      .from("cohorts")
      .select("id, name, status")
      .order("starts_on", { ascending: false }),
    admin.from("enrollments").select("user_id, cohort_id"),
  ]);

  const cohortList = (cohorts ?? []) as any[];
  // Default to the newest cohort rather than everyone: "where is everybody"
  // is almost always asked about the cohort currently running.
  const activeCohort =
    searchParams.cohort ??
    cohortList.find((c) => c.status === "active")?.id ??
    cohortList[0]?.id ??
    "";

  const userIds = [
    ...new Set(
      (enrollments ?? [])
        .filter((e: any) => !activeCohort || e.cohort_id === activeCohort)
        .map((e: any) => e.user_id),
    ),
  ] as string[];

  const roster = await getRosterProgress(userIds);

  // Never-started first (idleDays null sorts last by date but is the most
  // urgent state), then longest-idle.
  const sorted = [...roster].sort((a, b) => {
    if (a.stoppedAt === null && b.stoppedAt !== null) return -1;
    if (b.stoppedAt === null && a.stoppedAt !== null) return 1;
    return (b.idleDays ?? 0) - (a.idleDays ?? 0);
  });

  const neverStarted = sorted.filter((r) => r.stoppedAt === null).length;
  const stalled = sorted.filter(
    (r) => r.idleDays !== null && r.idleDays >= 7,
  ).length;
  const active = sorted.length - neverStarted - stalled;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-6">
        <div>
          <p className="text-[11px] font-mono font-medium uppercase tracking-[0.22em] text-phosphor-ink">
            Progress
          </p>
          <h1 className="mt-3 font-display text-4xl font-bold tracking-[-0.02em] text-ink">
            Exactly where everyone stopped.
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
            The last thing each student touched — a lesson, a flow step, a
            resource — and how long ago. Sorted by who has been idle longest,
            because that's the list worth acting on.
          </p>
        </div>
        {cohortList.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {cohortList.map((c) => (
              <Link
                key={c.id}
                href={`/admin/progress?cohort=${c.id}`}
                className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
                  c.id === activeCohort
                    ? "border-phosphor bg-phosphor/10 text-ink"
                    : "border-line text-ink-soft hover:border-ink/30"
                }`}
              >
                {c.name}
              </Link>
            ))}
          </div>
        )}
      </div>

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <Tally
          label="Never started"
          value={neverStarted}
          tone={neverStarted > 0 ? "bad" : "muted"}
          hint="No recorded activity at all"
        />
        <Tally
          label="Stalled 7+ days"
          value={stalled}
          tone={stalled > 0 ? "warn" : "muted"}
          hint="Started, then went quiet"
        />
        <Tally
          label="Active this week"
          value={active}
          tone="ok"
          hint="Touched something in the last 7 days"
        />
      </section>

      <Card className="mt-6 !p-0 overflow-hidden">
        {sorted.length === 0 ? (
          <div className="p-10 text-center">
            <Users className="mx-auto h-8 w-8 text-ink-faint" />
            <p className="mt-3 text-sm text-ink-soft">
              Nobody is enrolled in this cohort yet.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
                  <th className="px-5 py-3">Student</th>
                  <th className="px-5 py-3">Stopped at</th>
                  <th className="px-5 py-3">Last seen</th>
                  <th className="px-5 py-3">Course</th>
                  <th className="px-5 py-3">Flows</th>
                  <th className="px-5 py-3">Resources</th>
                  <th className="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <Row key={r.userId} row={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ row }: { row: RosterProgress }) {
  const Icon = row.stoppedAt ? AREA_ICON[row.stoppedAt.area] : Users;
  const idle = row.idleDays;
  const idleTone =
    idle === null
      ? "text-red-600 dark:text-red-400"
      : idle >= 14
        ? "text-red-600 dark:text-red-400"
        : idle >= 7
          ? "text-amber-600 dark:text-amber-400"
          : "text-ink-soft";

  return (
    <tr className="border-b border-line last:border-0 hover:bg-wash">
      <td className="px-5 py-3">
        <Link
          href={`/admin/students/${row.userId}`}
          className="font-medium text-ink hover:text-phosphor-ink"
        >
          {row.name || row.email}
        </Link>
        {row.name && (
          <div className="font-mono text-xs text-ink-faint">{row.email}</div>
        )}
      </td>
      <td className="px-5 py-3">
        {row.stoppedAt ? (
          <div className="flex items-start gap-2">
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <div className="min-w-0">
              <div className="truncate text-ink">{row.stoppedAt.label}</div>
              {row.stoppedAt.detail && (
                <div className="text-xs text-ink-faint">
                  {row.stoppedAt.detail}
                </div>
              )}
            </div>
          </div>
        ) : (
          <span className="text-xs italic text-red-600 dark:text-red-400">
            never started
          </span>
        )}
      </td>
      <td className={`px-5 py-3 text-xs ${idleTone}`}>
        {row.stoppedAt ? (
          <>
            <LocalTime value={row.stoppedAt.at} mode="date" />
            <div className="text-ink-faint">
              {idle === 0 ? "today" : `${idle}d ago`}
            </div>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-5 py-3 tabular-nums text-ink-soft">{row.lessonsDone}</td>
      <td className="px-5 py-3 tabular-nums text-ink-soft">{row.flowsDone}</td>
      <td className="px-5 py-3 tabular-nums text-ink-soft">
        {row.resourcesOpened}
      </td>
      <td className="px-5 py-3">
        <Link
          href={`/admin/students/${row.userId}`}
          className="text-ink-faint hover:text-ink"
          aria-label={`Open ${row.name || row.email}`}
        >
          <ArrowRight className="h-4 w-4" />
        </Link>
      </td>
    </tr>
  );
}

function Tally({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: "ok" | "warn" | "bad" | "muted";
}) {
  const colors = {
    ok: "text-emerald-700 dark:text-emerald-300",
    warn: "text-amber-700 dark:text-amber-300",
    bad: "text-red-700 dark:text-red-300",
    muted: "text-ink-faint",
  } as const;
  return (
    <div className="rounded-xl border border-line bg-wash px-4 py-4">
      <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
        {label}
      </p>
      <p className={`mt-1 text-3xl font-semibold tracking-tight ${colors[tone]}`}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-ink-faint">{hint}</p>
    </div>
  );
}
