"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Textarea, Label } from "@/components/ui/input";
import { waiveCharge, cancelCharge, refundCharge } from "./actions";
import { Check, X, Undo2 } from "lucide-react";
import { getActionError } from "@/lib/action-error";

type Kind = "waive" | "cancel" | "refund";

export function ChargeRowActions({
  chargeId,
  status,
}: {
  chargeId: string;
  status: "pending" | "paid" | "waived" | "cancelled" | "refunded";
}) {
  const router = useRouter();
  const [confirmKind, setConfirmKind] = useState<Kind | null>(null);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function execute() {
    setError(undefined);
    start(async () => {
      try {
        if (confirmKind === "waive") await waiveCharge(chargeId, reason);
        if (confirmKind === "cancel") await cancelCharge(chargeId);
        if (confirmKind === "refund") await refundCharge(chargeId, reason);
        setConfirmKind(null);
        setReason("");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <>
      <div className="flex items-center justify-end gap-2 text-xs">
        {status === "pending" && (
          <>
            <button
              type="button"
              onClick={() => setConfirmKind("waive")}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-wash px-2 py-1 text-ink-soft hover:border-emerald-300/40 hover:text-emerald-700 dark:hover:text-emerald-300"
            >
              <Check className="h-3 w-3" /> Waive
            </button>
            <button
              type="button"
              onClick={() => setConfirmKind("cancel")}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-wash px-2 py-1 text-ink-soft hover:border-red-400/40 hover:text-red-700 dark:hover:text-red-300"
            >
              <X className="h-3 w-3" /> Cancel
            </button>
          </>
        )}
        {status === "paid" && (
          <button
            type="button"
            onClick={() => setConfirmKind("refund")}
            className="inline-flex items-center gap-1 rounded-md border border-line bg-wash px-2 py-1 text-ink-soft hover:border-amber-300/40 hover:text-amber-700 dark:hover:text-amber-300"
          >
            <Undo2 className="h-3 w-3" /> Refund
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirmKind === "waive"}
        title="Waive this charge?"
        description={
          <>
            <p>The student keeps access and won't be billed.</p>
            <div className="mt-3 text-left">
              <Label>Reason (optional)</Label>
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. financial-aid scholarship"
              />
            </div>
            {error && <p className="mt-2 text-red-700 dark:text-red-300">{error}</p>}
          </>
        }
        confirmLabel="Waive"
        pending={pending}
        onConfirm={execute}
        onCancel={() => !pending && setConfirmKind(null)}
      />
      <ConfirmDialog
        open={confirmKind === "cancel"}
        title="Cancel this charge?"
        description={
          <>
            <p>The charge is removed without payment or waiver. Use this if it was issued by mistake.</p>
            {error && <p className="mt-2 text-red-700 dark:text-red-300">{error}</p>}
          </>
        }
        confirmLabel="Cancel charge"
        destructive
        pending={pending}
        onConfirm={execute}
        onCancel={() => !pending && setConfirmKind(null)}
      />
      <ConfirmDialog
        open={confirmKind === "refund"}
        title="Refund this charge?"
        description={
          <>
            <p>
              This refunds the full amount through Stripe back to the student's
              original card. The charge stays on record for accounting.
            </p>
            <div className="mt-3 text-left">
              <Label>Reason (optional)</Label>
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. charge issued in error"
              />
            </div>
            {error && <p className="mt-2 text-red-700 dark:text-red-300">{error}</p>}
          </>
        }
        confirmLabel="Refund"
        destructive
        pending={pending}
        onConfirm={execute}
        onCancel={() => !pending && setConfirmKind(null)}
      />
    </>
  );
}
