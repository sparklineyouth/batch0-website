import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { createClient } from "@/lib/supabase/server";
import { fmtDateOnly } from "@/lib/pre-cohort";
import { loadStudentAssignments, type StudentItem } from "@/lib/assignments-server";
import { formatEastern, studentGroup } from "@/lib/assignments";
import { StatusChip } from "@/components/assignments/status-chip";
import { AppHeader, AppBody, Section, Row, Empty, Alert } from "@/components/app/frame";
import type { Role } from "@/lib/types";

export const metadata = { title: "Assignments · batch0" };
export const dynamic = "force-dynamic";

const GROUPS = [
  { key: "due", title: "Due soon" },
  { key: "upcoming", title: "Upcoming" },
  { key: "done", title: "Done" },
] as const;

/** What's due, from a phone. Same reads and same submit action as /dashboard/assignments. */
export default async function StudentAppAssignments() {
  const { profile } = await requireViewer();
  const access = await getStudentAccess(profile.role as Role);
  if (!access.enrolled || access.preCohort) {
    const startLabel = fmtDateOnly(access.cohortStartsOn);
    return (
      <>
        <AppHeader title="Assignments" eyebrow="Locked" />
        <AppBody>
          <Alert tone="info" title="Assignments open when your cohort starts.">
            {startLabel ? `Starting ${startLabel}.` : null}
          </Alert>
        </AppBody>
      </>
    );
  }
  const now = new Date();
  const { ready, items } = await loadStudentAssignments(await createClient(), profile.id, { now });
  const grouped: Record<(typeof GROUPS)[number]["key"], StudentItem[]> = { due: [], upcoming: [], done: [] };
  for (const item of items) grouped[studentGroup(item.status, item.assignment.due_at, now)].push(item);
  grouped.done.reverse();

  return (
    <>
      <AppHeader title="Assignments" />
      <AppBody>
        {!ready || items.length === 0 ? (
          <Empty>{ready ? "Nothing assigned yet." : "Assignments aren't set up yet."}</Empty>
        ) : (
          GROUPS.filter((g) => grouped[g.key].length > 0).map((g) => (
            <Section key={g.key} title={g.title}>
              <div className="rounded-2xl border border-line px-4 sm:px-5">
                {grouped[g.key].map(({ assignment: a, status }) => (
                  <Row
                    key={a.id}
                    label={a.title}
                    value={a.due_at ? `Due ${formatEastern(a.due_at)}` : "No due date"}
                    meta={a.week ? `Week ${a.week}` : undefined}
                    href={`/app/assignments/${a.id}`}
                    prefetch={false}
                    muted={g.key === "done"}
                    right={<StatusChip status={status} />}
                  />
                ))}
              </div>
            </Section>
          ))
        )}
      </AppBody>
    </>
  );
}
