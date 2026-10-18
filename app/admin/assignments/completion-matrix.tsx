"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { Drawer } from "@/components/assignments/drawer";
import { StatusChip } from "@/components/assignments/status-chip";
import { SubmissionView } from "@/components/assignments/submission-view";
import { ReviewForm } from "@/components/assignments/review-form";
import { getActionError } from "@/lib/action-error";
import { formatEastern, formatEasternDay, type DerivedStatus } from "@/lib/assignments";
import { loadReviewCell, setExcused, type ReviewCell } from "./actions";

export type MatrixColumn = { id: string; title: string; week: number | null; dueAt: string | null };
export type MatrixStudentRow = {
  userId: string;
  name: string;
  cells: Record<string, DerivedStatus | null>;
  missing: number;
  done: number;
  due: number;
};

/**
 * Students × released assignments. Click a cell to review it.
 *
 * `failed`: the cohort board couldn't be read (loadCohortBoard). The matrix
 * says so in place of the table, but the review drawer still opens for a
 * deep link (?review=, the Overview's and the waiting list's "Review"): it
 * reads that one cell on its own (loadReviewCell), so a failed board is no
 * reason to lose it.
 */
export function CompletionMatrix({
  columns,
  rows,
  missingOnly: initialMissingOnly,
  initialCell = null,
  failed = false,
}: {
  columns: MatrixColumn[];
  rows: MatrixStudentRow[];
  missingOnly: boolean;
  /** A cell whose drawer is open on arrival (a deep link from the Overview). */
  initialCell?: { assignmentId: string; userId: string } | null;
  failed?: boolean;
}) {
  const [missingOnly, setMissingOnly] = useState(initialMissingOnly);
  const [cell, setCell] = useState<{ assignmentId: string; userId: string } | null>(null);
  // Opened after mount, not as the initial state: the drawer is a portal the
  // server never renders, so it must not be there on the hydrating pass.
  const initialKey = initialCell ? `${initialCell.assignmentId}:${initialCell.userId}` : null;
  useEffect(() => {
    if (initialCell) setCell(initialCell);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);
  const shown = missingOnly ? rows.filter((r) => r.missing >= 2) : rows;
  const flagged = rows.filter((r) => r.missing >= 2).length;

  return (
    <div>
      {failed ? (
        <p role="status" className="border-y border-line py-10 text-center text-sm text-red-600 dark:text-red-400">
          Couldn&apos;t load this cohort&apos;s assignments just now. Reload to try again.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
            Missing 2+ <span className="text-ink-faint">({flagged})</span>
          </label>
        </div>
      )}
      {failed ? null : columns.length === 0 || rows.length === 0 ? (
        <p className="mt-3 border-y border-line py-8 text-center text-sm text-ink-soft">
          {rows.length === 0 ? "Nobody enrolled yet." : "Nothing released yet."}
        </p>
      ) : shown.length === 0 ? (
        <p className="mt-3 border-y border-line py-8 text-center text-sm text-ink-soft">Nobody is missing 2 or more.</p>
      ) : (
        <div className="mt-3 overflow-x-auto border-y border-line">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left align-bottom">
                <th className="sticky left-0 z-10 bg-paper py-2 pr-3 font-mono text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                  Student
                </th>
                <th className="px-2 py-2 font-mono text-[10px] font-medium uppercase tracking-wider text-ink-faint">Done</th>
                {columns.map((c) => (
                  <th key={c.id} className="min-w-[7rem] px-2 py-2 align-bottom">
                    <span className="block max-w-[9rem] truncate text-xs font-medium text-ink" title={c.title}>
                      {c.title}
                    </span>
                    <span className="block text-[10px] font-normal text-ink-faint">
                      {[c.week ? `Wk ${c.week}` : null, c.dueAt ? formatEasternDay(c.dueAt) : null].filter(Boolean).join(" · ") || "No due date"}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((r) => (
                <tr key={r.userId}>
                  <td className="sticky left-0 z-10 max-w-[11rem] truncate bg-paper py-2 pr-3 text-ink" title={r.name}>
                    {r.name}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 font-mono text-xs tabular-nums text-ink-soft">
                    {r.done}/{r.due}
                  </td>
                  {columns.map((c) => {
                    const status = r.cells[c.id];
                    return (
                      <td key={c.id} className="px-2 py-2">
                        {status ? (
                          <button
                            type="button"
                            className="press rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor"
                            onClick={() => setCell({ assignmentId: c.id, userId: r.userId })}
                            aria-label={`${r.name}: ${c.title}`}
                          >
                            <StatusChip status={status} audience="staff" />
                          </button>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Drawer open={!!cell} title="Review" onClose={() => setCell(null)}>
        {cell && <ReviewPanel key={`${cell.assignmentId}:${cell.userId}`} {...cell} />}
      </Drawer>
    </div>
  );
}

function ReviewPanel({ assignmentId, userId }: { assignmentId: string; userId: string }) {
  const router = useRouter();
  const [data, setData] = useState<ReviewCell | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    loadReviewCell({ assignmentId, userId })
      .then((res) => {
        if (!live) return;
        if (res.ok && res.data) setData(res.data);
        else if (!res.ok) setError(res.error);
      })
      .catch((e) => {
        if (live) setError(getActionError(e));
      });
    return () => {
      live = false;
    };
  }, [assignmentId, userId, version]);

  function excuse(excused: boolean) {
    setError(null);
    start(async () => {
      try {
        const res = await setExcused({ assignmentId, userId, excused });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setVersion((v) => v + 1);
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  if (!data) return error ? <FieldError>{error}</FieldError> : <p className="text-sm text-ink-faint">Loading…</p>;
  const s = data.submission;
  const excused = s?.status === "excused";
  return (
    <div className="space-y-5">
      <div>
        <p className="text-[15px] font-medium text-ink">{data.student.name || data.student.email}</p>
        <p className="mt-0.5 text-sm text-ink-soft">
          {data.assignment.title}
          {data.assignment.week ? ` · Week ${data.assignment.week}` : ""}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
          <StatusChip status={data.status} audience="staff" />
          {data.assignment.due_at && <span>Due {formatEastern(data.assignment.due_at)}</span>}
          {s?.submitted_at && (
            <span>
              Submitted <LocalTime value={s.submitted_at} mode="datetime-short" />
            </span>
          )}
        </div>
        {!data.enrolled && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
            No longer in this cohort. What they handed in can still be reviewed.
          </p>
        )}
      </div>
      {s && (s.body || s.link_url) ? (
        <div className="border-t border-line pt-4">
          <SubmissionView body={s.body} link={s.link_url} />
        </div>
      ) : (
        <p className="border-t border-line pt-4 text-sm text-ink-soft">Nothing handed in.</p>
      )}
      {s && !excused && (s.body || s.link_url) && (
        <div className="border-t border-line pt-4">
          <ReviewForm
            submissionId={s.id}
            initialFeedback={s.feedback}
            onDone={() => setVersion((v) => v + 1)}
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
        <FieldError>{error}</FieldError>
        {/* setExcused works on the cohort's roster, which they've left. */}
        {data.enrolled && (
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => excuse(!excused)}>
            {excused ? "Undo excuse" : "Excuse"}
          </Button>
        )}
      </div>
    </div>
  );
}
