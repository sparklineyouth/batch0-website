"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Play, XCircle, RotateCcw, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { getActionError } from "@/lib/action-error";
import { cancelQueued, cancelAllPending, retryQueued, runQueueNow } from "./actions";

export function OutboxControls({ pendingCount }: { pendingCount: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [confirmCancelAll, setConfirmCancelAll] = useState(false);

  function run(fn: () => Promise<{ ok: boolean; message: string }>) {
    start(async () => {
      setMessage(undefined);
      try {
        const res = await fn();
        setFailed(!res.ok);
        setMessage(res.message);
        router.refresh();
      } catch (err) {
        setFailed(true);
        setMessage(getActionError(err));
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        onClick={() => run(runQueueNow)}
        disabled={pending}
      >
        <Play className="h-4 w-4" /> {pending ? "Running…" : "Run queue now"}
      </Button>
      {pendingCount > 0 && (
        <Button
          variant="danger"
          size="sm"
          onClick={() => setConfirmCancelAll(true)}
          disabled={pending}
        >
          <XCircle className="h-4 w-4" /> Cancel all {pendingCount} pending
        </Button>
      )}
      {message && (
        <span
          role="status"
          className={`text-xs ${
            failed ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"
          }`}
        >
          {message}
        </span>
      )}

      <ConfirmDialog
        open={confirmCancelAll}
        onCancel={() => setConfirmCancelAll(false)}
        onConfirm={() => {
          setConfirmCancelAll(false);
          run(cancelAllPending);
        }}
        title={`Cancel all ${pendingCount} queued emails?`}
        description="Nothing waiting in the queue will send, including anything automations have lined up. Already-sent email is unaffected."
        confirmLabel="Cancel them all"
        pending={pending}
        destructive
      />
    </div>
  );
}

/** Per-row cancel / retry. */
export function RowAction({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();

  const canCancel = status === "pending";
  const canRetry = status === "failed" || status === "canceled" || status === "skipped";
  if (!canCancel && !canRetry) return null;

  return (
    <div className="flex items-center justify-end gap-3">
      {error && <span className="text-xs text-red-500">{error}</span>}
      {canCancel && (
        <Link
          href={`/admin/email/outbox/${id}`}
          className="inline-flex items-center gap-1 text-xs font-semibold text-ink-soft hover:text-ink"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Link>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(undefined);
            try {
              const res = canCancel ? await cancelQueued(id) : await retryQueued(id);
              if (!res.ok) setError(res.error ?? "Failed");
              else router.refresh();
            } catch (err) {
              setError(getActionError(err));
            }
          })
        }
        className="inline-flex items-center gap-1 text-xs font-semibold text-ink-soft hover:text-ink disabled:opacity-50"
      >
        {canCancel ? (
          <>
            <XCircle className="h-3.5 w-3.5" /> Cancel
          </>
        ) : (
          <>
            <RotateCcw className="h-3.5 w-3.5" /> Retry
          </>
        )}
      </button>
    </div>
  );
}
