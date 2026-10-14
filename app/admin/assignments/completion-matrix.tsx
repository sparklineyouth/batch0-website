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

/** Students × released assignments. Click a cell to review it. */
export function CompletionMatrix({
  columns,
  rows,
  missingOnly: initialMissingOnly,
}: {
  columns: MatrixColumn[];
  rows: MatrixStudentRow[];
  missingOnly: boolean;
}) {
  const [missingOnly, setMissingOnly] = useState(initialMissingOnly);
  const [cell, setCell] = useState<{ assignmentId: string; userId: string } | null>(null);
  const shown = missingOnly ? rows.filter((r) => r.missing >= 2) : rows;
  const flagged = rows.filter((r) => r.missing >= 2).length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
          Missing 2+ <span className="text-ink-faint">({flagged})</span>
        </label>
      </div>
      {columns.length === 0 || rows.length === 0 ? (
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
    loadReviewCell({ assignmentId, userId }).then((res) => {
      if (!live) return;
      if (res.ok && res.data) setData(res.data);
      else if (!res.ok) setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [assignmentId, userId, version]);

  function excuse(excused: boolean) {
    setError(null);
    start(async () => {
      const res = await setExcused({ assignmentId, userId, excused });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setVersion((v) => v + 1);
      router.refresh();
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
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => excuse(!excused)}>
          {excused ? "Undo excuse" : "Excuse"}
        </Button>
      </div>
    </div>
  );
}
