"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import type { ActionResult } from "@/lib/action-result";
import {
  changeTicketStatus,
  setTicketAssignee,
  setTicketCategory,
  setTicketPayment,
  setTicketPriority,
  setTicketSensitive,
} from "@/app/admin/support/actions";
import {
  CATEGORY_GROUPS,
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  STAFF_STATUS_LABELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  isSensitiveCategory,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/support-access";

/**
 * Status, assignee, priority, category, confidentiality and charge-linking for
 * one ticket.
 *
 * Errors land inline on the control that failed — there is no toast primitive
 * in this project, and the optimistic-lock message ("someone else changed
 * this") is the whole reason a failure here has to be readable rather than a
 * silent no-op.
 *
 * Every control is hidden unless the viewer holds support.manage; the actions
 * re-assert it regardless, because a server action is its own entry point.
 * The confidential toggle additionally needs support.sensitive.
 */
export function TicketControls({
  ticketId,
  status,
  assignedTo,
  priority,
  category,
  sensitive,
  staff,
  payments,
  linkedPaymentId,
  canManage,
  canSeeSensitive,
  viewerId,
}: {
  ticketId: string;
  status: TicketStatus;
  assignedTo: string | null;
  priority: TicketPriority;
  category: TicketCategory;
  sensitive: boolean;
  staff: { id: string; name: string }[];
  payments: { id: string; label: string }[];
  linkedPaymentId: string | null;
  canManage: boolean;
  canSeeSensitive: boolean;
  /** The signed-in staff member, for "Take it". */
  viewerId: string;
}) {
  const router = useRouter();
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();

  if (!canManage) return null;

  function run<T>(fn: () => Promise<ActionResult<T>>, onDone?: (data: T | undefined) => void) {
    setErr(undefined);
    start(async () => {
      try {
        const res = await fn();
        if (!res.ok) setErr(res.error);
        else if (onDone) onDone(res.data);
        else router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  function changeCategory(next: string) {
    // Moving a request into "Report a concern" makes it confidential, and
    // without support.sensitive that means it disappears from this person's
    // queue — say so before it happens, not after.
    if (
      !canSeeSensitive &&
      isSensitiveCategory(next as TicketCategory) &&
      !window.confirm(
        "This makes the request confidential. Only staff who can see confidential concerns will be able to open it — including you. Continue?",
      )
    ) {
      return;
    }
    run(
      () => setTicketCategory({ ticketId, category: next }),
      (data) => {
        if (data?.hidden) router.push("/admin/support");
        else router.refresh();
      },
    );
  }

  function changeSensitive(next: boolean) {
    if (
      !next &&
      !window.confirm(
        "Everyone with access to the support queue will be able to read this request, and its bells and emails will carry its content. Continue?",
      )
    ) {
      return;
    }
    run(() => setTicketSensitive({ ticketId, sensitive: next }));
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
        {/* The common assignment, in one click. Only offered when the viewer
            is someone this ticket may be assigned to (the picker's own list,
            which already applies the confidential-concern rule). */}
        {assignedTo !== viewerId && staff.some((s) => s.id === viewerId) && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => run(() => setTicketAssignee({ ticketId, assigneeId: viewerId }))}
          >
            Take it
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

        <label className="block">
          <span className="mb-1.5 block font-mono text-xs font-medium uppercase tracking-wider text-ink-soft">
            Priority
          </span>
          <Select
            value={priority}
            disabled={pending}
            onChange={(e) =>
              run(() => setTicketPriority({ ticketId, priority: e.target.value }))
            }
          >
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </Select>
        </label>

        <label className="block">
          <span className="mb-1.5 block font-mono text-xs font-medium uppercase tracking-wider text-ink-soft">
            Category
          </span>
          <Select
            value={category}
            disabled={pending}
            onChange={(e) => changeCategory(e.target.value)}
          >
            {CATEGORY_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.categories.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </label>
      </div>

      {canSeeSensitive && (
        <label className="mt-3 flex cursor-pointer select-none items-start gap-2 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={sensitive}
            disabled={pending}
            onChange={(e) => changeSensitive(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 accent-phosphor"
          />
          <span>
            <span className="font-medium text-ink">Confidential</span> — only
            staff who can see confidential concerns can open it, and its bells
            and team emails carry no content.
          </span>
        </label>
      )}

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
            Only this account&rsquo;s payments are listed. &ldquo;Not
            linked&rdquo; unlinks it.
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
