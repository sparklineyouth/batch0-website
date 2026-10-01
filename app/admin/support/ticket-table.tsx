"use client";
import Link from "next/link";
import { LocalTime } from "@/components/ui/local-time";
import { TableShell } from "@/app/admin/email/metric-ui";
import { CATEGORY_LABELS, type TicketCategory, type TicketStatus } from "@/lib/support-access";

/**
 * The queue table.
 *
 * A client component with no state, which looks odd until you notice why: the
 * only interactive thing in a row is the link to the detail page, and every
 * action lives there instead. Deliberate — a one-click "resolve" in a list is
 * how a support queue ends up with tickets marked done that nobody read.
 */

/** What the server page hands over. Plain values only — this crosses the RSC boundary. */
export type SupportTicketRow = {
  id: string;
  reference: string;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  requesterLabel: string;
  assignedName: string | null;
  replyCount: number;
  needsReply: boolean;
  lastActivityAt: string;
  createdAt: string;
};

const STATUS_PILL: Record<TicketStatus, string> = {
  // Same vocabulary and the same colours as the email outbox,
  // deliberately: an admin who has learned to read one queue in this panel
  // should not have to learn a second.
  open: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  waiting_on_requester: "border-line bg-wash text-ink-soft",
  resolved:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  closed: "border-line bg-wash text-ink-faint",
};

const STATUS_SHORT: Record<TicketStatus, string> = {
  open: "open",
  waiting_on_requester: "waiting",
  resolved: "resolved",
  closed: "closed",
};

export function SupportTicketTable({ rows }: { rows: SupportTicketRow[] }) {
  return (
    <TableShell
      head={
        <>
          <th className="px-5 py-3 font-medium">Request</th>
          <th className="px-5 py-3 font-medium">From</th>
          <th className="px-5 py-3 font-medium">Status</th>
          <th className="px-5 py-3 text-right font-medium">Replies</th>
          <th className="px-5 py-3 font-medium">Last activity</th>
        </>
      }
    >
      {rows.map((r) => (
        <tr key={r.id} className="border-b border-line last:border-0 hover:bg-wash">
          <td className="px-5 py-3">
            <Link
              href={`/admin/support/${r.id}`}
              prefetch={false}
              className="font-medium text-ink hover:underline"
            >
              <span className="block max-w-[320px] truncate" title={r.subject}>
                {r.subject}
              </span>
            </Link>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-faint">
              <span className="font-mono uppercase tracking-wider">
                {r.reference}
              </span>
              <span>{CATEGORY_LABELS[r.category]}</span>
              {r.category === "refund" && (
                <span className="font-medium text-amber-700 dark:text-amber-300">
                  has a deadline
                </span>
              )}
            </span>
          </td>
          <td className="px-5 py-3">
            <span
              className="block max-w-[200px] truncate text-ink-soft"
              title={r.requesterLabel}
            >
              {r.requesterLabel}
            </span>
            {r.assignedName && (
              <span className="text-[11px] text-ink-faint">
                → {r.assignedName}
              </span>
            )}
          </td>
          <td className="px-5 py-3">
            <span
              className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                STATUS_PILL[r.status]
              }`}
            >
              {STATUS_SHORT[r.status]}
            </span>
          </td>
          <td className="px-5 py-3 text-right tabular-nums text-ink-soft">
            {r.replyCount}
          </td>
          <td className="whitespace-nowrap px-5 py-3 text-xs text-ink-faint">
            <LocalTime value={r.lastActivityAt} mode="datetime-short" />
          </td>
        </tr>
      ))}
    </TableShell>
  );
}
