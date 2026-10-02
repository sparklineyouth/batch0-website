import { CheckCircle2, Clock, Lock, NotebookPen } from "lucide-react";
import { LocalTime } from "@/components/ui/local-time";
import { AttachmentList } from "@/components/support/attachment-list";
import {
  groupAttachmentsByReply,
  type SupportAttachment,
} from "@/lib/support-attachment-rules";
import {
  CATEGORY_LABELS,
  type TicketCategory,
  type TicketStatus,
} from "@/lib/support-access";
import { StaffComposer } from "./staff-composer";

/**
 * The team's view of the thread: the request, every reply with the internal
 * notes marked out, each message's files under it, and the staff composer.
 *
 * It reads like the requester's thread (components/support/ticket-thread.tsx)
 * on purpose — same bylines, same order — but renders on its own, from the
 * server, so the staff page can carry what the requester's never will:
 * internal notes and internal files, the resolve step, and uploads scoped to
 * a support.manage assertion. Serialisable props only; the page has already
 * scrubbed the messages to the requester-safe shape and renders anything
 * more sensitive (the email address, the payments) in its own strip.
 */

export type StaffThreadTicket = {
  id: string;
  reference: string;
  subject: string;
  body: string;
  category: TicketCategory;
  status: TicketStatus;
  createdAt: string;
  /** Pre-formatted, fixed-zone arrival time. See formatReceivedAt(). */
  receivedAtLabel: string;
  requesterName: string | null;
  accountName: string | null;
};

export type StaffThreadReply = {
  id: string;
  authorName: string;
  body: string;
  isStaff: boolean;
  isInternal: boolean;
  createdAt: string;
};

export function StaffThread({
  ticket,
  replies,
  ticketId,
  canManage,
  controls,
  attachments = [],
}: {
  ticket: StaffThreadTicket;
  replies: StaffThreadReply[];
  ticketId: string;
  canManage: boolean;
  controls?: React.ReactNode;
  /** Every file on the ticket, internal ones included (listAttachments with includeInternal). */
  attachments?: SupportAttachment[];
}) {
  const isRefund = ticket.category === "refund";
  const finished = ticket.status === "resolved" || ticket.status === "closed";
  const requesterLabel =
    ticket.requesterName?.trim() || ticket.accountName?.trim() || "Requester";
  const files = groupAttachmentsByReply(attachments);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone="muted">{CATEGORY_LABELS[ticket.category]}</Tag>
        <Tag tone={finished ? "muted" : "phosphor"}>
          {finished ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
          {ticket.status.replace(/_/g, " ")}
        </Tag>
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          {ticket.reference}
        </span>
        {controls && <div className="ml-auto flex flex-wrap gap-2">{controls}</div>}
      </div>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink md:text-3xl">
        {ticket.subject}
      </h1>

      {/* The arrival time, stated rather than buried in a byline: for a refund
          request it is what the 48-hour window is measured against. */}
      <p className="mt-2 text-sm text-ink-faint">
        Recorded {ticket.receivedAtLabel}
        {isRefund && (
          <>
            {" · "}
            <span className="text-ink-soft">
              the time this refund request stopped the clock
            </span>
          </>
        )}
      </p>

      <article className="mt-5 rounded-xl border border-line bg-wash p-5">
        <Byline name={requesterLabel} isStaff={false} isInternal={false} at={ticket.createdAt} />
        <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">
          {ticket.body}
        </p>
        <AttachmentList items={files.request} access={{ kind: "session" }} />
      </article>

      <h2 className="mt-8 text-[11px] font-mono font-medium uppercase tracking-[0.2em] text-ink-faint">
        {replies.length === 0
          ? "No replies yet"
          : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
      </h2>

      {replies.length === 0 && !finished && (
        <p className="mt-3 text-sm text-ink-soft">Nobody has answered this yet.</p>
      )}

      {replies.length > 0 && (
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {replies.map((r) => (
            <li key={r.id} className={r.isInternal ? "bg-amber-500/[0.06] py-4 pl-3" : "py-4"}>
              <Byline name={r.authorName} isStaff={r.isStaff} isInternal={r.isInternal} at={r.createdAt} />
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
                {r.body}
              </p>
              <AttachmentList items={files.byReply[r.id] ?? []} access={{ kind: "session" }} />
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <StaffComposer ticketId={ticketId} status={ticket.status} />
      ) : (
        // A read-only viewer (support.view without support.manage) sees the
        // whole thread and gets no composer; the action would refuse them
        // anyway. Said about their permissions, never about the ticket.
        <p className="mt-6 flex items-center gap-2 text-sm text-ink-faint">
          <Lock className="h-3.5 w-3.5" />
          You have read access to this request. Answering it needs the
          &ldquo;Answer support requests&rdquo; permission.
        </p>
      )}
    </div>
  );
}

function Tag({ tone, children }: { tone: "phosphor" | "muted"; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono font-medium uppercase tracking-wider ${
        tone === "phosphor" ? "bg-phosphor/15 text-phosphor-ink" : "border border-line text-ink-faint"
      }`}
    >
      {children}
    </span>
  );
}

function Byline({
  name,
  isStaff,
  isInternal,
  at,
}: {
  name: string;
  isStaff: boolean;
  isInternal: boolean;
  at: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div
        aria-hidden
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          isStaff ? "bg-phosphor text-on-phosphor" : "bg-ink text-paper"
        }`}
      >
        {name.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium text-ink">{name}</span>
          {isStaff && !isInternal && (
            <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-phosphor-ink">
              batch0 team
            </span>
          )}
          {isInternal && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
              <NotebookPen className="h-3 w-3" />
              internal note
            </span>
          )}
        </p>
        <p className="text-[11px] text-ink-faint">
          <LocalTime value={at} mode="datetime-short" />
        </p>
      </div>
    </div>
  );
}
