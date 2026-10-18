import Link from "next/link";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { teamCompletion, type MatrixRow } from "@/lib/assignments";

type Member = { userId: string; name: string };

/**
 * How far along a team is, at the top of /admin/teams/[id]: the share of its
 * released assignments its members have handed in, who is behind, and where
 * the Demo Day submission stands. Read-only; the completion matrix at
 * /admin/assignments is where anything gets reviewed or excused.
 *
 * `board` is null when the team has no cohort or the assignment tables
 * aren't there yet (0093, lib/assignments-server.ts) — the card says so
 * instead of showing a zero. `boardFailed` is a read that failed for any
 * other reason: the card says it couldn't load, rather than "not set up yet"
 * or a member count it doesn't have, and the rest of the page is unaffected.
 *
 * `assignments` is whether the viewer may see per-student assignment counts
 * at all (assignments.manage or people.view — the page itself only needs
 * teams.manage); without it the card is just the Demo Day line. `matrixLink`
 * is whether they can open /admin/assignments, which needs assignments.manage.
 */
export function TeamReadiness({
  cohortId,
  assignments,
  matrixLink,
  board,
  boardFailed = false,
  members,
  pitch,
}: {
  cohortId: string | null;
  assignments: boolean;
  matrixLink: boolean;
  board: { rows: MatrixRow[] } | null;
  boardFailed?: boolean;
  members: Member[];
  pitch: { deck_url?: string | null; video_url: string | null; submitted_at: string | null } | null;
}) {
  const completion = assignments && board ? teamCompletion(board.rows, members.map((m) => m.userId)) : null;
  const byUser = new Map((board?.rows ?? []).map((r) => [r.userId, r]));

  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-faint">Readiness</h2>
        {cohortId && assignments && matrixLink && (
          <Link href={`/admin/assignments?cohort=${cohortId}`} prefetch={false} className="text-xs link-ink">
            Completion matrix →
          </Link>
        )}
      </div>

      {!assignments ? null : !cohortId ? (
        <p className="mt-2 text-sm text-ink-soft">This team isn&apos;t in a cohort, so it has no assignments.</p>
      ) : boardFailed ? (
        <p role="status" className="mt-2 text-sm text-red-600 dark:text-red-400">
          Couldn&apos;t load assignment progress just now. Reload to try again.
        </p>
      ) : !completion ? (
        <p className="mt-2 text-sm text-ink-soft">Assignments aren&apos;t set up yet.</p>
      ) : completion.counted === 0 ? (
        <p className="mt-2 text-sm text-ink-soft">No member is enrolled in this team&apos;s cohort.</p>
      ) : completion.percent === null ? (
        <p className="mt-2 text-sm text-ink-soft">Nothing has come due yet.</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-ink">
            <span className="font-display text-3xl font-bold tabular-nums">{completion.percent}%</span>{" "}
            <span className="text-ink-soft">
              of assignments handed in · {completion.done} of {completion.due}
              {completion.missing > 0 && (
                <span className="text-amber-700 dark:text-amber-300"> · {completion.missing} missing</span>
              )}
            </span>
          </p>
          <ul className="mt-3 divide-y divide-line border-y border-line text-sm">
            {members.map((m) => {
              const row = byUser.get(m.userId);
              return (
                <li key={m.userId} className="flex items-center justify-between gap-3 py-2">
                  <span className="truncate text-ink">{m.name}</span>
                  <span className="shrink-0 tabular-nums text-ink-soft">
                    {!row ? (
                      <span className="text-ink-faint">not enrolled</span>
                    ) : (
                      <>
                        {row.done} of {row.due}
                        {row.missing > 0 && (
                          <span className="text-amber-700 dark:text-amber-300"> · {row.missing} missing</span>
                        )}
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <p className="mt-3 text-sm text-ink-soft">
        Demo Day: deck {pitch?.deck_url ? "in" : "missing"} · video {pitch?.video_url ? "in" : "missing"} ·{" "}
        {pitch?.submitted_at ? (
          <>
            submitted <LocalTime value={pitch.submitted_at} mode="date" />
          </>
        ) : (
          "not submitted"
        )}
      </p>
    </Card>
  );
}
