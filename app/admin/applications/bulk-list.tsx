"use client";
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { Button } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { bulkDecideApplications } from "./[id]/actions";
import { getActionError } from "@/lib/action-error";
import { CheckSquare, Square } from "lucide-react";

// Statuses where bulk-decide makes sense. Decided / paid / enrolled rows
// don't get a usable checkbox — clicking them just navigates.
const DECIDABLE = new Set(["submitted", "draft"]);

// Score tone duplicated from page.tsx — keeping it local rather than
// hoisting to a shared file because the list is the only consumer and a
// shared helper would feel premature for one function.
function scoreTone(score: number) {
  if (score >= 8)
    return "bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300";
  if (score >= 5)
    return "bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300";
  return "bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300";
}

const NOTE_TEMPLATES: { label: string; body: string }[] = [
  {
    label: "Reject · standard",
    body:
      "Thanks for applying. We can't offer you a seat in this cohort — we had more strong applicants than seats. If you keep building, we'd love to see another application from you.",
  },
  {
    label: "Reject · close",
    body:
      "Thanks for applying. This was a close call and we'd love to see you apply again next cohort. To strengthen the next application, focus on: ",
  },
  {
    label: "Accept · standard",
    body:
      "Excited to have you in the cohort. Your application stood out — looking forward to seeing what you build. We'll send onboarding details once payment is in.",
  },
];

type AppRow = {
  id: string;
  full_name: string | null;
  age: number | null;
  status: string;
  submitted_at: string | null;
  ai_score: number | null;
  ai_reviewed_at: string | null;
  profile: { email: string | null } | null;
};

export function ApplicationsBulkList({ apps }: { apps: AppRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState<null | "accepted" | "rejected">(null);
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [lastResult, setLastResult] = useState<string | undefined>();

  const decidableIds = useMemo(
    () => apps.filter((a) => DECIDABLE.has(a.status)).map((a) => a.id),
    [apps],
  );
  const allSelected =
    decidableIds.length > 0 && decidableIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(decidableIds));
  }

  function applyTemplate(body: string) {
    setNotes((prev) => (prev.trim() ? `${prev.trim()}\n\n${body}` : body));
  }

  function runBulk(decision: "accepted" | "rejected") {
    setErr(undefined);
    setLastResult(undefined);
    start(async () => {
      try {
        const res = await bulkDecideApplications({
          applicationIds: Array.from(selected),
          decision,
          notes,
        });
        const parts = [`${res.succeeded} ${decision}`];
        if (res.failed > 0) parts.push(`${res.failed} failed`);
        if (res.skipped > 0) parts.push(`${res.skipped} skipped (not decidable)`);
        setLastResult(parts.join(" · "));
        setConfirm(null);
        setSelected(new Set());
        setNotes("");
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  if (apps.length === 0) {
    return <p className="p-6 text-sm text-ink-faint">No applications.</p>;
  }

  return (
    <div className="text-sm">
      <div className="grid grid-cols-[auto_minmax(0,2fr)_minmax(0,2fr)_minmax(0,0.5fr)_minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b border-line bg-wash px-5 py-3 text-xs font-mono uppercase tracking-wider text-ink-faint">
        <button
          type="button"
          onClick={toggleAll}
          aria-label={allSelected ? "Deselect all" : "Select all decidable"}
          className="-ml-1 -my-1 rounded p-1 text-ink-faint hover:text-ink"
        >
          {allSelected ? (
            <CheckSquare className="h-4 w-4" />
          ) : (
            <Square className="h-4 w-4" />
          )}
        </button>
        <div>Applicant</div>
        <div>Email</div>
        <div>Age</div>
        <div>AI</div>
        <div>Status</div>
        <div>Submitted</div>
      </div>

      {apps.map((a) => {
        const decidable = DECIDABLE.has(a.status);
        const checked = selected.has(a.id);
        return (
          <div
            key={a.id}
            className={`group grid grid-cols-[auto_minmax(0,2fr)_minmax(0,2fr)_minmax(0,0.5fr)_minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 border-b border-line px-5 py-3 last:border-0 hover:bg-wash ${
              checked ? "bg-spark/5" : ""
            }`}
          >
            <button
              type="button"
              onClick={() => decidable && toggle(a.id)}
              disabled={!decidable}
              aria-label={
                decidable
                  ? checked
                    ? "Deselect"
                    : "Select"
                  : `Cannot bulk-decide (${a.status})`
              }
              className="-ml-1 -my-1 rounded p-1 text-ink-faint enabled:hover:text-ink disabled:opacity-30"
            >
              {checked ? (
                <CheckSquare className="h-4 w-4 text-spark-ink" />
              ) : (
                <Square className="h-4 w-4" />
              )}
            </button>
            <Link
              href={`/admin/applications/${a.id}`}
              className="truncate text-ink group-hover:text-spark-ink"
            >
              {a.full_name || "—"}
            </Link>
            <div className="truncate text-ink-soft">
              {a.profile?.email ?? "—"}
            </div>
            <div className="text-ink-soft tabular-nums">{a.age ?? "—"}</div>
            <div>
              {typeof a.ai_score === "number" ? (
                <span
                  title={
                    a.ai_reviewed_at
                      ? `AI screen run ${new Date(a.ai_reviewed_at).toLocaleString()}`
                      : undefined
                  }
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${scoreTone(a.ai_score)}`}
                >
                  {a.ai_score}/10
                </span>
              ) : (
                <span className="text-ink-faint">—</span>
              )}
            </div>
            <div>
              <StatusBadge status={a.status} />
            </div>
            <div className="text-ink-faint font-mono tabular-nums">
              <LocalTime value={a.submitted_at} mode="date" />
            </div>
          </div>
        );
      })}

      {/* Floating action bar — sticks to the bottom of the viewport while
          rows are selected. Positioned outside the table grid so the
          column layout doesn't grow when it appears. */}
      {someSelected && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-wash/95 backdrop-blur md:left-60">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-3">
            <div className="text-sm">
              <span className="font-semibold text-ink tabular-nums">{selected.size}</span>
              <span className="text-ink-soft"> selected</span>
            </div>
            {lastResult && (
              <span className="text-xs text-emerald-700 dark:text-emerald-300">{lastResult}</span>
            )}
            {err && <span className="text-xs text-red-700 dark:text-red-300">{err}</span>}
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              disabled={pending}
            >
              Clear
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirm("rejected")}
              disabled={pending}
            >
              Reject {selected.size}
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirm("accepted")}
              disabled={pending}
            >
              Accept {selected.size}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === "accepted"
            ? `Accept ${selected.size} application${selected.size === 1 ? "" : "s"}?`
            : `Reject ${selected.size} application${selected.size === 1 ? "" : "s"}?`
        }
        destructive={confirm === "rejected"}
        confirmLabel={confirm === "accepted" ? "Accept all" : "Reject all"}
        pending={pending}
        onCancel={() => !pending && setConfirm(null)}
        onConfirm={() => confirm && runBulk(confirm)}
        description={
          <div className="text-left">
            <p className="text-sm text-ink-soft">
              Each applicant gets the same notes
              {confirm === "accepted"
                ? " and an acceptance email."
                : " and a rejection email."}{" "}
              Already-decided rows are skipped automatically.
            </p>
            <div className="mt-3">
              <Label htmlFor="bulk-notes">
                Notes to all applicants (optional)
              </Label>
              <Textarea
                id="bulk-notes"
                rows={4}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={pending}
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {NOTE_TEMPLATES.map((t) => (
                  <button
                    key={t.label}
                    type="button"
                    onClick={() => applyTemplate(t.body)}
                    disabled={pending}
                    className="rounded-full border border-line bg-wash px-2.5 py-1 text-xs text-ink-soft hover:border-ink/30 hover:text-ink disabled:opacity-50"
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        }
      />
    </div>
  );
}
