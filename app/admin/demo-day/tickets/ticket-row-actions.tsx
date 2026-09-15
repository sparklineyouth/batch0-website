"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Textarea, Label } from "@/components/ui/input";
import { Send, X, Undo2 } from "lucide-react";
import { getActionError } from "@/lib/action-error";
import type { DemoDayTicketStatus } from "@/lib/types";
import {
  resendDemoDayTicket,
  cancelDemoDayTicket,
  refundDemoDayTicket,
} from "./actions";
import { CopyLinkButton } from "./copy-link-button";

type Kind = "resend" | "cancel" | "refund";

/**
 * Per-row controls, mirroring the fees & fines table: a payable ticket can
 * be resent or cancelled, a paid one refunded. The pay link is copyable in
 * every state — a cancelled link is still useful to find in an inbox.
 */
export function TicketRowActions({
  ticketId,
  status,
  url,
}: {
  ticketId: string;
  status: DemoDayTicketStatus;
  url: string;
}) {
  const router = useRouter();
  const [confirmKind, setConfirmKind] = useState<Kind | null>(null);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [flash, setFlash] = useState<string | undefined>();

  function execute() {
    setError(undefined);
    start(async () => {
      try {
        const res =
          confirmKind === "resend"
            ? await resendDemoDayTicket(ticketId)
            : confirmKind === "cancel"
              ? await cancelDemoDayTicket(ticketId)
              : await refundDemoDayTicket(ticketId, reason);
        if (!res.ok) return setError(res.error);
        if (confirmKind === "resend") {
          setFlash("Sent again.");
          setTimeout(() => setFlash(undefined), 2000);
        }
        setConfirmKind(null);
        setReason("");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  const btn =
    "inline-flex items-center gap-1 rounded-md border border-line bg-wash px-2 py-1 text-ink-soft";

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
        {flash && (
          <span className="text-emerald-700 dark:text-emerald-300">{flash}</span>
        )}
        <CopyLinkButton url={url} />
        {status === "sent" && (
          <>
            <button
              type="button"
              onClick={() => setConfirmKind("resend")}
              className={`${btn} hover:border-phosphor/40 hover:text-phosphor-ink`}
            >
              <Send className="h-3 w-3" /> Resend
            </button>
            <button
              type="button"
              onClick={() => setConfirmKind("cancel")}
              className={`${btn} hover:border-red-400/40 hover:text-red-700 dark:hover:text-red-300`}
            >
              <X className="h-3 w-3" /> Cancel
            </button>
          </>
        )}
        {status === "paid" && (
          <button
            type="button"
            onClick={() => setConfirmKind("refund")}
            className={`${btn} hover:border-amber-300/40 hover:text-amber-700 dark:hover:text-amber-300`}
          >
            <Undo2 className="h-3 w-3" /> Refund
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirmKind === "resend"}
        title="Resend the pay link?"
        description={
          <>
            <p>The same link goes out again to the same address.</p>
            {error && <p className="mt-2 text-red-700 dark:text-red-300">{error}</p>}
          </>
        }
        confirmLabel="Resend"
        pending={pending}
        onConfirm={execute}
        onCancel={() => !pending && setConfirmKind(null)}
      />
      <ConfirmDialog
        open={confirmKind === "cancel"}
        title="Cancel this ticket?"
        description={
          <>
            <p>
              The link stops working and can&rsquo;t be paid. Nothing has been
              charged. Send a new ticket if you change your mind.
            </p>
            {error && <p className="mt-2 text-red-700 dark:text-red-300">{error}</p>}
          </>
        }
        confirmLabel="Cancel ticket"
        destructive
        pending={pending}
        onConfirm={execute}
        onCancel={() => !pending && setConfirmKind(null)}
      />
      <ConfirmDialog
        open={confirmKind === "refund"}
        title="Refund this ticket?"
        description={
          <>
            <p>
              Refunds the full amount through Stripe to the original card. The
              ticket no longer admits them to Demo Day.
            </p>
            <div className="mt-3 text-left">
              <Label>Reason (optional)</Label>
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. can no longer attend"
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
