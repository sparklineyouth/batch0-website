import Link from "next/link";
import { requireUser, getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";
import { loadStudentAssignments, type StudentItem } from "@/lib/assignments-server";
import { formatEastern, studentGroup } from "@/lib/assignments";
import { StatusChip } from "@/components/assignments/status-chip";

export const metadata = { title: "Assignments · batch0" };

const GROUPS = [
  { key: "due", title: "Due soon" },
  { key: "upcoming", title: "Upcoming" },
  { key: "done", title: "Done" },
] as const;

export default async function AssignmentsPage() {
  const user = await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");
  if (!access.enrolled) {
    return <LockedFeature title="Assignments" applicationStatus={access.applicationStatus} />;
  }
  const now = new Date();
  const { ready, items } = await loadStudentAssignments(await createClient(), user.id, { now });
  const grouped = Object.fromEntries(GROUPS.map((g) => [g.key, [] as StudentItem[]])) as Record<
    (typeof GROUPS)[number]["key"],
    StudentItem[]
  >;
  for (const item of items) grouped[studentGroup(item.status, item.assignment.due_at, now)].push(item);
  grouped.done.reverse();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl text-ink">Assignments</h1>
      {!ready || items.length === 0 ? (
        <p className="mt-8 border-y border-line py-10 text-center text-sm text-ink-soft">
          {ready ? "Nothing assigned yet." : "Assignments aren't set up yet."}
        </p>
      ) : (
        GROUPS.filter((g) => grouped[g.key].length > 0).map((g) => (
          <section key={g.key} className="mt-8">
            <h2 className="font-mono text-xs uppercase tracking-wider text-ink-faint">{g.title}</h2>
            <ul className="mt-3 divide-y divide-line border-y border-line">
              {grouped[g.key].map(({ assignment: a, status }) => (
                <li key={a.id}>
                  <Link
                    href={`/dashboard/assignments/${a.id}`}
                    className="press flex items-center gap-4 py-4 hover:bg-wash"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium text-ink">{a.title}</p>
                      <p className="mt-0.5 text-xs text-ink-faint">
                        {[a.week ? `Week ${a.week}` : null, a.due_at ? `Due ${formatEastern(a.due_at)}` : "No due date"]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <StatusChip status={status} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
