"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { reconcileStripeNow } from "./actions";
import { getActionError } from "@/lib/action-error";

/**
 * Admin-triggered reconciliation. Walks Stripe and replays every session
 * and refund through the same fulfillment path the webhook uses, so any
 * transaction the platform missed — or one that predates the webhook —
 * lands in the database. Idempotent; running it twice is a no-op.
 */
export function SyncStripeButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  function run() {
    setError(undefined);
    setResult(undefined);
    start(async () => {
      try {
        const s = await reconcileStripeNow({});
        setResult(
          `${s.sessionsScanned} session${s.sessionsScanned === 1 ? "" : "s"} scanned · ` +
            `${s.paid} paid · ${s.closed} closed out · ${s.refunds} refund${
              s.refunds === 1 ? "" : "s"
            }` +
            (s.errors.length ? ` · ${s.errors.length} skipped` : ""),
        );
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        aria-busy={pending}
        title="Replay every Stripe transaction into the platform"
        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-wash px-3 py-1.5 text-xs font-medium text-ink-soft hover:border-ink/30 disabled:opacity-60"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />
        {pending ? "Syncing…" : "Sync from Stripe"}
      </button>
      {result && <p className="text-[11px] text-ink-faint">{result}</p>}
      {error && (
        <p className="text-[11px] text-red-700 dark:text-red-300">{error}</p>
      )}
    </div>
  );
}
