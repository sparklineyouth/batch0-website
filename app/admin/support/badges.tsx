import { Lock } from "lucide-react";
import { PRIORITY_LABELS, type TicketPriority } from "@/lib/support-access";

/**
 * The two marks a request carries in the admin — its priority, and the lock
 * on a confidential concern — shared by the queue and the detail page so they
 * read the same in both. No "use client" and no hooks, so either side can
 * render them.
 *
 * Normal and low are deliberately quiet: the eye should land on urgent (a
 * concern, by default) and high (a refund, whose 48-hour window is running).
 */
const PRIORITY_TONE: Record<TicketPriority, string> = {
  urgent: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  high: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  normal: "border-line bg-wash text-ink-faint",
  low: "border-line bg-wash text-ink-faint",
};

/** Priorities worth marking in a list, where everything else stays quiet. */
export function isLoudPriority(priority: TicketPriority): boolean {
  return priority === "urgent" || priority === "high";
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${PRIORITY_TONE[priority]}`}
    >
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

export function ConfidentialBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-line bg-wash px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-soft">
      <Lock className="h-3 w-3" aria-hidden />
      Confidential
    </span>
  );
}
