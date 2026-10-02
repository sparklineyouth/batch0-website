"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Clock, Lock, NotebookPen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import {
  CATEGORY_LABELS,
  REPLY_BODY_MAX,
  STATUS_LABELS,
  type TicketCategory,
  type TicketStatus,
} from "@/lib/support-access";
import type { RejectedAttachment, SupportAttachment } from "@/lib/support-attachment-rules";

/**
 * A support ticket thread, as the requester sees it.
 *
 * Both of the requester's pages mount this — /support/t/[token] from the
 * email and /dashboard/support/[reference] signed in — through the wrappers
 * that own their credentials (requester-thread.tsx, own-thread.tsx). The
 * team's page renders its own thread (app/admin/support/[id]/staff-thread),
 * because it carries what this one never will: internal notes and their
 * files, and a composer that can resolve.
 *
 * Serialisable props only, and note what is NOT in these prop types: no
 * `token`, no `requesterEmail`, no `authorEmail`. lib/support.ts's
 * forRequester() returns exactly the shape below, so a page that forgets to
 * scrub gets a type error rather than a leak.
 *
 * `onReply` is injected rather than imported, because the two pages post
 * through different credentials — a token, or the owner's session — and the
 * component must not be the thing that decides which. It just calls what it
 * was handed.
 *
 * Files follow the same rule. The thread decides where they go — under the
 * original request, under each reply, and an attach control in the composer —
 * but the wrapper renders them (`renderFiles`, `renderAttach`), because a file
 * link and an upload are authorized exactly as a reply is, and on the emailed
 * page that means by the token, which this component never holds.
 */

/** The hidden input the attach control fills with the finished uploads (JSON). */
const ATTACH_FIELD = "attachments";

/**
 * What the composer hands the wrapper's attach control (an AttachmentPicker
 * takes these props as they are): hold Send while anything is uploading,
 * clear the files once a message has gone, and stay still while one is sending.
 */
export type TicketAttachSlot = {
  name: string;
  onBusyChange: (busy: boolean) => void;
  resetKey: number;
  disabled: boolean;
};

/** A send that went through can still report files that didn't make it onto the message. */
export type TicketReplyOutcome = { rejectedFiles?: RejectedAttachment[] };

/**
 * A thread's files split by message, as a wrapper takes them from its page:
 * groupAttachmentsByReply's result (a plain record, so it crosses from the
 * server page). Requester pages pass only files that aren't internal.
 */
export type TicketThreadFiles = {
  request: SupportAttachment[];
  byReply: Record<string, SupportAttachment[]>;
};

/** The files on one message — the original request (`null`) or a reply. */
export function filesOn(
  files: TicketThreadFiles | undefined,
  replyId: string | null,
): SupportAttachment[] {
  if (!files) return [];
  return (replyId === null ? files.request : files.byReply[replyId]) ?? [];
}

export type TicketThreadTicket = {
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

export type TicketThreadReply = {
  id: string;
  authorName: string;
  body: string;
  isStaff: boolean;
  isInternal: boolean;
  createdAt: string;
};

export function TicketThread({
  ticket,
  replies,
  canReply,
  controls,
  startNewHref,
  renderFiles,
  renderAttach,
  onReply,
}: {
  ticket: TicketThreadTicket;
  replies: TicketThreadReply[];
  /** False on a closed ticket. */
  canReply: boolean;
  controls?: React.ReactNode;
  /** Requester surfaces: where "start a new one" goes once a request is closed. */
  startNewHref?: string;
  /** The files on the original request (`replyId` null) or on one reply. */
  renderFiles?: (replyId: string | null) => React.ReactNode;
  /** The composer's attach control. Without it, replies are text only. */
  renderAttach?: (slot: TicketAttachSlot) => React.ReactNode;
  onReply: (args: {
    body: string;
    /** The attach control's finished uploads as JSON, or "" without one. */
    attachments: string;
  }) => Promise<TicketReplyOutcome | void>;
}) {
  const isRefund = ticket.category === "refund";
  const finished = ticket.status === "resolved" || ticket.status === "closed";
  const requesterLabel =
    ticket.requesterName?.trim() || ticket.accountName?.trim() || "You";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone="muted">{CATEGORY_LABELS[ticket.category]}</Tag>
        <Tag tone={finished ? "muted" : "phosphor"}>
          {finished ? (
            <CheckCircle2 className="h-3 w-3" />
          ) : (
            <Clock className="h-3 w-3" />
          )}
          {STATUS_LABELS[ticket.status]}
        </Tag>
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          {ticket.reference}
        </span>
        {controls && <div className="ml-auto flex flex-wrap gap-2">{controls}</div>}
      </div>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink md:text-3xl">
        {ticket.subject}
      </h1>

      {/* The arrival time, stated rather than buried in a byline. For a refund
          request this is the operative fact of the whole page — it is what the
          refund policy measures the 48-hour window against — so it gets its own
          line and says what it means. */}
      <p className="mt-2 text-sm text-ink-faint">
        Recorded {ticket.receivedAtLabel}
        {isRefund && (
          <>
            {" · "}
            <span className="text-ink-soft">
              this is the time your refund request stopped the clock
            </span>
          </>
        )}
      </p>

      <article className="mt-5 rounded-xl border border-line bg-wash p-5">
        <Byline
          name={requesterLabel}
          isStaff={false}
          isInternal={false}
          at={ticket.createdAt}
        />
        <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">
          {ticket.body}
        </p>
        {renderFiles?.(null)}
      </article>

      <h2 className="mt-8 text-[11px] font-mono font-medium uppercase tracking-[0.2em] text-ink-faint">
        {replies.length === 0
          ? "No replies yet"
          : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
      </h2>

      {replies.length === 0 && !finished && (
        <p className="mt-3 text-sm text-ink-soft">
          A human reads every request. You&rsquo;ll get an email the moment
          someone replies — you don&rsquo;t need to check back.
        </p>
      )}

      {replies.length > 0 && (
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {replies.map((r) => (
            <li
              key={r.id}
              className={r.isInternal ? "bg-amber-500/[0.06] py-4 pl-3" : "py-4"}
            >
              <Byline
                name={r.authorName}
                isStaff={r.isStaff}
                isInternal={r.isInternal}
                at={r.createdAt}
              />
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
                {r.body}
              </p>
              {renderFiles?.(r.id)}
            </li>
          ))}
        </ul>
      )}

      {canReply ? (
        <ReplyComposer
          onReply={onReply}
          resolved={ticket.status === "resolved"}
          renderAttach={renderAttach}
        />
      ) : ticket.status === "closed" ? (
        <p className="mt-6 flex items-start gap-2 text-sm text-ink-faint">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {startNewHref ? (
            // A plain anchor: this also renders on the emailed-link page,
            // whose URL is a secret, and a full load leaves no client-side
            // history behind it.
            <span>
              This request is closed &mdash;{" "}
              <a href={startNewHref} className="link-ink">
                start a new one
              </a>{" "}
              if you still need help.
            </span>
          ) : (
            <span>
              This request is closed and isn&rsquo;t accepting replies. Open a
              new one if you still need help.
            </span>
          )}
        </p>
      ) : null}
    </div>
  );
}

function Tag({
  tone,
  children,
}: {
  tone: "phosphor" | "muted";
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono font-medium uppercase tracking-wider ${
        tone === "phosphor"
          ? "bg-phosphor/15 text-phosphor-ink"
          : "border border-line text-ink-faint"
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

function ReplyComposer({
  onReply,
  resolved,
  renderAttach,
}: {
  onReply: (args: { body: string; attachments: string }) => Promise<TicketReplyOutcome | void>;
  resolved: boolean;
  renderAttach?: (slot: TicketAttachSlot) => React.ReactNode;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | undefined>();
  // A file still uploading holds Send: a message sent mid-upload goes without
  // the file its author thinks is on it. Each send that goes through bumps
  // `sent`, which clears the attach control for the next message.
  const [uploading, setUploading] = useState(false);
  const [sent, setSent] = useState(0);
  const [rejected, setRejected] = useState<RejectedAttachment[]>([]);
  const [pending, start] = useTransition();

  // A form rather than a click handler, so the attach control's hidden input
  // travels with the message — and a screenshot pasted into the text box
  // attaches (the picker listens for pastes on its surrounding form).
  function send(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(undefined);
    const text = body.trim();
    if (!text || uploading) return;
    setRejected([]);
    const files = new FormData(e.currentTarget).get(ATTACH_FIELD);
    start(async () => {
      try {
        const outcome = await onReply({
          body: text,
          attachments: typeof files === "string" ? files : "",
        });
        setBody("");
        setSent((n) => n + 1);
        setRejected((outcome && outcome.rejectedFiles) || []);
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <form onSubmit={send} className="mt-6">
      <label htmlFor="ticket-reply" className="sr-only">
        Your reply
      </label>
      <Textarea
        id="ticket-reply"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        // ⌘/Ctrl+Enter sends, through the form, so it takes the same path —
        // and the same "still uploading" hold — as the button.
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder={
          resolved
            ? "Still not sorted? Reply here and it reopens."
            : "Add anything else that would help…"
        }
        maxLength={REPLY_BODY_MAX}
        rows={4}
        error={err}
      />
      {renderAttach && (
        <div className="mt-3">
          {renderAttach({
            name: ATTACH_FIELD,
            onBusyChange: setUploading,
            resetKey: sent,
            disabled: pending,
          })}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <FieldError id="ticket-reply-error">{err}</FieldError>
        <div className="ml-auto flex items-center gap-3">
          <Button
            type="submit"
            size="sm"
            disabled={pending || uploading || !body.trim()}
          >
            {pending ? "Sending…" : uploading ? "Waiting for files…" : "Send"}
          </Button>
        </div>
      </div>
      {/* The message went; these files didn't. The picker has been cleared
          for the next message, so say which ones to attach again. */}
      {rejected.length > 0 && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300"
        >
          <p className="font-medium">
            Sent, but {rejected.length === 1 ? "one file" : `${rejected.length} files`}{" "}
            didn&rsquo;t attach:
          </p>
          <ul className="mt-1 space-y-0.5">
            {rejected.map((f, i) => (
              <li key={i} className="break-words">
                <span className="font-medium">{f.name}</span> — {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}

/**
 * "This is solved" — the requester's one status control on their own
 * request, on either of their pages. `onSolve` is the wrapper's action, for
 * the same reason `onReply` is: the two pages authorize it differently.
 */
export function MarkSolvedButton({
  onSolve,
}: {
  onSolve: () => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();

  function solve() {
    setErr(undefined);
    start(async () => {
      try {
        const res = await onSolve();
        if (res.ok) router.refresh();
        else setErr(res.error);
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <span className="flex items-center gap-2">
      {err && (
        <span role="alert" className="text-xs text-red-700 dark:text-red-300">
          {err}
        </span>
      )}
      <button
        type="button"
        onClick={solve}
        disabled={pending}
        className="press inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-ink-soft hover:border-ink/30 hover:text-ink disabled:opacity-50"
      >
        <CheckCircle2 className="h-3.5 w-3.5" />
        {pending ? "Saving…" : "This is solved"}
      </button>
    </span>
  );
}
