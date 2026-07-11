"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { Button } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { CheckSquare, Square } from "lucide-react";
import { ChargeRowActions } from "./row-actions";
import { bulkChargeAction, type BulkChargeAction } from "./actions";
import { getActionError } from "@/lib/action-error";

type ChargeStatus = "pending" | "paid" | "waived" | "cancelled" | "refunded";

type Row = {
  id: string;
  created_at: string;
  kind: "fee" | "fine";
  amount_cents: number;
  description: string;
  status: ChargeStatus;
  profile: { email: string | null; full_name: string | null } | null;
};

const BULKABLE_STATUSES = new Set<ChargeStatus>(["pending"]);

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function ChargesBulkList({ charges }: { charges: Row[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState<null | BulkChargeAction>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [lastResult, setLastResult] = useState<string | undefined>();

  const bulkableIds = useMemo(
    () => charges.filter((c) => BULKABLE_STATUSES.has(c.status)).map((c) => c.id),
    [charges],
  );
  const allSelected =
    bulkableIds.length > 0 && bulkableIds.every((id) => selected.has(id));
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
    else setSelected(new Set(bulkableIds));
  }

  function runBulk(action: BulkChargeAction) {
    setErr(undefined);
    setLastResult(undefined);
    start(async () => {
      try {
        const res = await bulkChargeAction({
          chargeIds: Array.from(selected),
          action,
          reason,
        });
        const parts = [`${res.succeeded} ${action}d`];
        if (res.failed > 0) parts.push(`${res.failed} failed`);
        if (res.skipped > 0) parts.push(`${res.skipped} skipped`);
        setLastResult(parts.join(" · "));
        setConfirm(null);
        setSelected(new Set());
        setReason("");
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  if (charges.length === 0) {
    return <p className="p-6 text-sm text-ink-soft">No charges match.</p>;
  }

  return (
    <div className="text-sm">
      <div className="grid grid-cols-[auto_minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,0.6fr)_minmax(0,0.7fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)] items-center gap-3 border-b border-line px-5 py-3 text-xs uppercase tracking-wider text-ink-faint">
        <button
          type="button"
          onClick={toggleAll}
          aria-label={allSelected ? "Deselect all" : "Select all pending"}
          className="-ml-1 -my-1 rounded p-1 text-ink-faint hover:text-ink"
        >
          {allSelected ? (
            <CheckSquare className="h-4 w-4" />
          ) : (
            <Square className="h-4 w-4" />
          )}
        </button>
        <div>Issued</div>
        <div>Student</div>
        <div>Type</div>
        <div>Amount</div>
        <div>Description</div>
        <div>Status</div>
        <div />
      </div>

      {charges.map((c) => {
        const checkable = BULKABLE_STATUSES.has(c.status);
        const checked = selected.has(c.id);
        return (
          <div
            key={c.id}
            className={`grid grid-cols-[auto_minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,0.6fr)_minmax(0,0.7fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)] items-center gap-3 border-b border-line px-5 py-3 last:border-0 hover:bg-wash ${
              checked ? "bg-spark/5" : ""
            }`}
          >
            <button
              type="button"
              onClick={() => checkable && toggle(c.id)}
              disabled={!checkable}
              aria-label={
                checkable
                  ? checked
                    ? "Deselect"
                    : "Select"
                  : `Not bulk-actionable (${c.status})`
              }
              className="-ml-1 -my-1 rounded p-1 text-ink-faint enabled:hover:text-ink disabled:opacity-30"
            >
              {checked ? (
                <CheckSquare className="h-4 w-4 text-spark-ink" />
              ) : (
                <Square className="h-4 w-4" />
              )}
            </button>
            <div className="truncate text-ink-soft">
              <LocalTime value={c.created_at} />
            </div>
            <div className="truncate">
              <div className="truncate text-ink">
                {c.profile?.full_name ?? "—"}
              </div>
              <div className="truncate text-xs text-ink-faint">
                {c.profile?.email}
              </div>
            </div>
            <div>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  c.kind === "fine"
                    ? "bg-red-500/10 text-red-700 dark:text-red-300"
                    : "bg-amber-500/10 text-amber-700 dark:text-amber-200"
                }`}
              >
                {c.kind}
              </span>
            </div>
            <div className="text-ink-soft">{fmt(c.amount_cents)}</div>
            <div className="truncate text-ink-soft">{c.description}</div>
            <div>
              <StatusBadge status={c.status} />
            </div>
            <div className="flex justify-end">
              {(c.status === "pending" || c.status === "paid") && (
                <ChargeRowActions chargeId={c.id} status={c.status} />
              )}
            </div>
          </div>
        );
      })}

      {someSelected && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper/95 backdrop-blur md:left-60">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-3">
            <div className="text-sm">
              <span className="font-semibold text-ink">{selected.size}</span>
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
              onClick={() => setConfirm("cancel")}
              disabled={pending}
            >
              Cancel {selected.size}
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirm("waive")}
              disabled={pending}
            >
              Waive {selected.size}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm === "waive"}
        title={`Waive ${selected.size} charge${selected.size === 1 ? "" : "s"}?`}
        confirmLabel="Waive all"
        pending={pending}
        onCancel={() => !pending && setConfirm(null)}
        onConfirm={() => runBulk("waive")}
        description={
          <div className="text-left">
            <p className="text-sm text-ink-soft">
              Selected pending charges will be marked waived; students
              get an in-app notification. Non-pending rows are skipped.
            </p>
            <div className="mt-3">
              <Label htmlFor="bulk-waive-reason">Reason (optional)</Label>
              <Textarea
                id="bulk-waive-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={pending}
                placeholder="e.g. financial-aid scholarship"
              />
            </div>
          </div>
        }
      />
      <ConfirmDialog
        open={confirm === "cancel"}
        title={`Cancel ${selected.size} charge${selected.size === 1 ? "" : "s"}?`}
        destructive
        confirmLabel="Cancel all"
        pending={pending}
        onCancel={() => !pending && setConfirm(null)}
        onConfirm={() => runBulk("cancel")}
        description={
          <p className="text-sm text-ink-soft">
            Selected pending charges will be cancelled without payment or
            waiver. Non-pending rows are skipped.
          </p>
        }
      />
    </div>
  );
}
