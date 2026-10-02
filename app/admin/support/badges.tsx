import { Lock } from "lucide-react";
import {
  PRIORITY_LABELS,
  SLA_TARGET_HOURS,
  formatElapsed,
  slaDueAt,
  slaState,
  type SlaState,
  type SlaTicket,
  type TicketPriority,
} from "@/lib/support-access";

/**
 * The marks a request carries in the admin — its priority, the lock on a
 * confidential concern, and where it stands against its reply target —
 * shared by the queue and the detail page so they read the same in both. No
 * "use client" and no hooks, so either side can render them.
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

/** Where a request waiting on the team stands against its reply target, in words. */
export type SlaCue = {
  state: SlaState;
  /** "overdue 3h 12m", "due in 2h 5m", or "waiting 5h 30m". */
  label: string;
  /** The target it is measured against, for the hover. */
  title: string;
};

/**
 * The reply-target cue for a request, or null when nobody owes a reply.
 *
 * Takes `now` instead of reading the clock, and the queue calls it on the
 * server at render time and hands the result down as strings. A duration
 * worked out in the browser would differ from the server's by however long
 * the page took to hydrate, and every row would be a hydration mismatch. The
 * page is force-dynamic, so its "now" is never older than the request.
 */
export function slaCue(t: SlaTicket, now: number): SlaCue | null {
  const due = slaDueAt(t);
  if (!due) return null;
  const dueMs = Date.parse(due);
  const state = slaState(t, now);
  // Never "0m": a request a few seconds either side of a boundary still
  // reads as a duration rather than as nothing at all.
  const span = (ms: number) => formatElapsed(Math.max(ms, 60_000));
  const label =
    state === "overdue"
      ? `overdue ${span(now - dueMs)}`
      : state === "due_soon"
        ? `due in ${span(dueMs - now)}`
        : `waiting ${span(now - Date.parse(t.requesterActivityAt))}`;
  return {
    state,
    label,
    title: `${PRIORITY_LABELS[t.priority]} priority: a reply is due ${SLA_TARGET_HOURS[t.priority]}h after their last message.`,
  };
}

/** Red when it's late, amber when it's close, otherwise as quiet as a timestamp. */
const SLA_TONE: Record<SlaState, string> = {
  overdue: "font-medium text-red-700 dark:text-red-300",
  due_soon: "font-medium text-amber-700 dark:text-amber-300",
  ok: "text-ink-faint",
};

export function SlaCueText({ cue }: { cue: SlaCue }) {
  return (
    <span title={cue.title} className={`text-[11px] tabular-nums ${SLA_TONE[cue.state]}`}>
      {cue.label}
    </span>
  );
}
