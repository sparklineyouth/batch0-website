"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import {
  changeTicketStatus,
  setTicketAssignee,
  setTicketPayment,
} from "@/app/admin/support/actions";
import {
  STAFF_STATUS_LABELS,
  TICKET_STATUSES,
  type TicketStatus,
} from "@/lib/support-access";

/**
 * Status, assignee, and charge-linking for one ticket.
 *
 * Errors land inline on the control that failed — there is no toast primitive
 * in this project, and the optimistic-lock message ("someone else changed
 * this") is the whole reason a failure here has to be readable rather than a
 * silent no-op.
 *
 * Every control is hidden unless the viewer holds support.manage; the actions
 * re-assert it regardless, because a server action is its own entry point.
 */
export function TicketControls({
  ticketId,
  status,
  assignedTo,
  staff,
  payments,
  linkedPaymentId,
  canManage,
}: {
  ticketId: string;
  status: TicketStatus;
  assignedTo: string | null;
  staff: { id: string; name: string }[];
  payments: { id: string; label: string }[];
  linkedPaymentId: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();

  if (!canManage) return null;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setErr(undefined);
    start(async () => {
      try {
        const res = await fn();
        if (!res.ok) setErr(res.error);
        else router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        {/* The two moves that actually happen. Resolve is the common one and
            gets the primary button; closing is for abuse and duplicates, which
            is why it is quiet and sits second. */}
        {status !== "resolved" && (
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              run(() =>
                changeTicketStatus({ ticketId, from: status, to: "resolved" }),
              )
            }
          >
            {pending ? "Saving…" : "Resolve & notify"}
          </Button>
        )}
        {status === "resolved" && (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              run(() => changeTicketStatus({ ticketId, from: status, to: "open" }))
            }
          >
            Reopen
          </Button>
        )}
        {status !== "closed" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              run(() => changeTicketStatus({ ticketId, from: status, to: "closed" }))
            }
          >
            Close without reply
          </Button>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block font-mono text-xs font-medium uppercase tracking-wider text-ink-soft">
            Status
          </span>
          <Select
            value={status}
            disabled={pending}
            onChange={(e) =>
              run(() =>
                changeTicketStatus({
                  ticketId,
                  from: status,
                  to: e.target.value,
                }),
              )
            }
          >
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STAFF_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </label>

        <label className="block">
          <span className="mb-1.5 block font-mono text-xs font-medium uppercase tracking-wider text-ink-soft">
            Owner
          </span>
          <Select
            value={assignedTo ?? ""}
            disabled={pending}
            onChange={(e) =>
              run(() =>
                setTicketAssignee({
                  ticketId,
                  assigneeId: e.target.value || null,
                }),
              )
            }
          >
            <option value="">Nobody yet</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {payments.length > 0 && (
        <label className="mt-3 block">
          <span className="mb-1.5 block font-mono text-xs font-medium uppercase tracking-wider text-ink-soft">
            Charge this is about
          </span>
          <Select
            value={linkedPaymentId ?? ""}
            disabled={pending}
            onChange={(e) =>
              run(() =>
                setTicketPayment({
                  ticketId,
                  paymentId: e.target.value || null,
                }),
              )
            }
          >
            <option value="">Not linked</option>
            {payments.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
          <span className="mt-1.5 block text-xs text-ink-faint">
            Only this account&rsquo;s payments are listed.
          </span>
        </label>
      )}

      {err && (
        <p role="alert" className="mt-3 text-xs text-red-700 dark:text-red-300">
          {err}
        </p>
      )}
    </div>
  );
}
