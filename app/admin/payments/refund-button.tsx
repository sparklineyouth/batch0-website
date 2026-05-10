"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { refundPayment } from "./actions";

export function RefundButton({
  paymentId,
  amountLabel,
}: {
  paymentId: string;
  amountLabel: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function execute() {
    setError(undefined);
    start(async () => {
      try {
        await refundPayment(paymentId);
        setOpen(false);
        router.refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Refund this payment"
        className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/70 hover:border-red-400/40 hover:text-red-300"
      >
        <Undo2 className="h-3 w-3" /> Refund
      </button>
      <ConfirmDialog
        open={open}
        title="Refund this payment?"
        description={
          <>
            <p>
              Refund <span className="text-white">{amountLabel}</span> back to
              the customer's card?
            </p>
            <p className="mt-2 text-amber-300/80">
              This is irreversible — the student will need to pay again to
              re-enroll.
            </p>
            {error && (
              <p className="mt-3 text-red-300">{error}</p>
            )}
          </>
        }
        confirmLabel="Refund"
        destructive
        pending={pending}
        onConfirm={execute}
        onCancel={() => !pending && setOpen(false)}
      />
    </>
  );
}
