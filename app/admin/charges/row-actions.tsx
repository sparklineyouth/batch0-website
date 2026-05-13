"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Textarea, Label } from "@/components/ui/input";
import { waiveCharge, cancelCharge } from "./actions";
import { Check, X } from "lucide-react";
import { getActionError } from "@/lib/action-error";

export function ChargeRowActions({ chargeId }: { chargeId: string }) {
  const router = useRouter();
  const [confirmKind, setConfirmKind] = useState<"waive" | "cancel" | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function execute() {
    setError(undefined);
    start(async () => {
      try {
        if (confirmKind === "waive") await waiveCharge(chargeId, reason);
        if (confirmKind === "cancel") await cancelCharge(chargeId);
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
        <button
          type="button"
          onClick={() => setConfirmKind("waive")}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-white/70 hover:border-emerald-300/40 hover:text-emerald-300"
        >
          <Check className="h-3 w-3" /> Waive
        </button>
        <button
          type="button"
          onClick={() => setConfirmKind("cancel")}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-white/70 hover:border-red-400/40 hover:text-red-300"
        >
          <X className="h-3 w-3" /> Cancel
        </button>
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
            {error && <p className="mt-2 text-red-300">{error}</p>}
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
            {error && <p className="mt-2 text-red-300">{error}</p>}
          </>
        }
        confirmLabel="Cancel charge"
        destructive
        pending={pending}
        onConfirm={execute}
        onCancel={() => !pending && setConfirmKind(null)}
      />
    </>
  );
}
