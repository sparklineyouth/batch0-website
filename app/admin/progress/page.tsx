import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { Meter } from "@/components/admin/charts";
import { getRosterProgress, type RosterProgress } from "@/lib/progress";
import { requirePermission } from "@/lib/auth";
import { easternDate } from "@/lib/assignments";
import { isUuid } from "@/lib/support-access";
import {
  canWriteFollowUps,
  followUpDueLabel,
  isFollowUpDue,
  type FollowUpView,
} from "@/lib/student-followups";
import { listActiveFollowUps, listDueFollowUps } from "@/lib/student-followups-server";
import { FollowUpButton, type FollowUpSummary } from "./follow-up-drawer";
import {
  BookOpen,
  Sparkles,
  FolderOpen,
  ArrowRight,
  Users,
  ClipboardList,
  Trophy,
} from "lucide-react";

export const metadata = { title: "Progress · Admin" };
export const dynamic = "force-dynamic";

const AREA_ICON = {
  course: BookOpen,
  flow: Sparkles,
  resource: FolderOpen,
  challenge: Trophy,
  assignment: ClipboardList,
} as const;

/** How many due follow-ups the list at the top shows; the count is exact. */
const DUE_LIST_MAX = 50;

/**
 * Where every student actually is.
 *
 * Sorted by how long they've been idle, longest first, because the question
 * this page exists to answer is "who has stalled?" — not "who is doing well".
 * A roster sorted alphabetically buries exactly the rows worth acting on.
 *
 * The Follow-up column and the "Follow-ups due" list (migration 0107) say
 * who on the team is already checking on whom, so two people don't chase
 * the same student. Only a person starts one — nothing here turns idle days
 * into a follow-up — and none of it messages anybody.
 */
export default async function AdminProgressPage(
  props: {
    searchParams: Promise<{ cohort?: string; followup?: string }>;
  }
) {
  const [searchParams, viewer] = await Promise.all([
    props.searchParams,
    requirePermission("people.view"),
  ]);
  const admin = createAdminClient();
  const canEditFollowUps = canWriteFollowUps(viewer.caps);
  // One "today" (New York) for the whole render: the due list, the column and
  // the drawer all say "due today" about the same day.
  const today = easternDate(new Date());
  const deepLink = isUuid(searchParams.followup) ? searchParams.followup.toLowerCase() : null;

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

  const [roster, openFollowUps, due] = await Promise.all([
    getRosterProgress(userIds),
    listActiveFollowUps(userIds),
    // Across every cohort: a follow-up due today is due whichever cohort
    // pill is selected. The Overview's attention list counts this same read.
    listDueFollowUps({ today, limit: DUE_LIST_MAX }),
  ]);
  const followUpsReady = openFollowUps.ready && due.ready;
  // Not set up (0107 not applied) and couldn't load are different sentences:
  // a timeout must not tell anyone the feature doesn't exist, or that
  // nothing is due.
  const followUpsFailed = !followUpsReady && (openFollowUps.failed || due.failed);
  const summaryOf = (f: FollowUpView | undefined): FollowUpSummary | null =>
    f
      ? {
          ownerName: f.ownerName,
          ownerIsViewer: !!f.ownerId && f.ownerId === viewer.profile.id,
          nextCheckOn: f.nextCheckOn,
          dueLabel: followUpDueLabel(f.nextCheckOn, today),
          due: isFollowUpDue(f, today),
        }
      : null;

  // The Overview's attention rows link here with ?followup=<student id>. That
  // opens a drawer of its own on arrival, because the student may be in
  // another cohort's roster than the one selected, or in none.
  let deepLinkName: string | null = null;
  if (deepLink) {
    const listed = roster.find((r) => r.userId === deepLink);
    const dueRow = due.rows.find((f) => f.studentId === deepLink);
    if (listed) deepLinkName = listed.name || listed.email;
    else if (dueRow) deepLinkName = dueRow.studentName;
    else {
      const { data } = await admin.from("profiles").select("full_name, email").eq("id", deepLink).maybeSingle();
      deepLinkName = data ? data.full_name?.trim() || data.email || "Student" : null;
    }
  }

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
          <h1 className="font-display text-4xl font-bold tracking-[-0.02em] text-ink">
            Progress
          </h1>
          <p className="mt-2 text-sm text-ink-soft">Idle longest first.</p>
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

      {followUpsFailed ? (
        <p role="status" className="mt-6 text-xs text-red-600 dark:text-red-400">
          Couldn&apos;t load follow-ups just now, so who is following up with whom isn&apos;t shown. Reload to try again.
        </p>
      ) : !followUpsReady ? (
        <p className="mt-6 text-xs text-ink-faint">Follow-ups aren&apos;t set up yet.</p>
      ) : (
        due.total > 0 && (
          <section id="follow-ups" className="mt-8 scroll-mt-24">
            <h2 className="font-mono text-xs uppercase tracking-wider text-ink-faint">
              Follow-ups due · {due.total}
            </h2>
            <ul className="mt-3 divide-y divide-line border-y border-line">
              {due.rows.map((f) => (
                <li key={f.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/admin/students/${f.studentId}`}
                      className="text-sm font-medium text-ink hover:text-phosphor-ink"
                    >
                      {f.studentName}
                    </Link>
                    <p className="mt-0.5 line-clamp-2 text-xs text-ink-soft">{f.note}</p>
                  </div>
                  <FollowUpButton
                    studentId={f.studentId}
                    studentName={f.studentName}
                    summary={summaryOf(f)}
                    canEdit={canEditFollowUps}
                  />
                </li>
              ))}
            </ul>
            {due.total > due.rows.length && (
              <p className="mt-2 text-xs text-ink-faint">
                Showing the {due.rows.length} most overdue of {due.total}.
              </p>
            )}
          </section>
        )
      )}

      {deepLink && deepLinkName && followUpsReady && (
        <FollowUpButton
          studentId={deepLink}
          studentName={deepLinkName}
          summary={null}
          canEdit={canEditFollowUps}
          defaultOpen
          hideTrigger
        />
      )}

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
                  <th className="px-5 py-3">Assignments</th>
                  <th className="px-5 py-3">Course</th>
                  <th className="px-5 py-3">Flows</th>
                  <th className="px-5 py-3">Resources</th>
                  {followUpsReady && <th className="px-5 py-3">Follow-up</th>}
                  <th className="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <Row
                    key={r.userId}
                    row={r}
                    followUp={
                      followUpsReady ? (
                        <FollowUpButton
                          studentId={r.userId}
                          studentName={r.name || r.email}
                          summary={summaryOf(openFollowUps.byStudent.get(r.userId))}
                          canEdit={canEditFollowUps}
                        />
                      ) : null
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ row, followUp }: { row: RosterProgress; followUp: React.ReactNode }) {
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
      <td className="px-5 py-3 tabular-nums text-ink-soft">{row.assignmentsDone}</td>
      <td className="px-5 py-3 tabular-nums text-ink-soft">{row.lessonsDone}</td>
      <td className="px-5 py-3 tabular-nums text-ink-soft">{row.flowsDone}</td>
      <td className="px-5 py-3 tabular-nums text-ink-soft">
        {row.resourcesOpened}
      </td>
      {followUp && <td className="px-5 py-3">{followUp}</td>}
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
