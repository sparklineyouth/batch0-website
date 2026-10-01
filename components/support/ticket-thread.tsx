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

/**
 * A support ticket thread, rendered the same way for both audiences.
 *
 * The requester's pages — /support/t/[token] from the email and
 * /dashboard/support/[reference] signed in — and the admin page at
 * /admin/support/[id] all mount this. They differ in three things and nothing
 * else: the header strip above it (the admin one names the requester), the
 * `controls` slot, and whether internal notes are in `replies` at all.
 *
 * Serialisable props only, and note what is NOT in these prop types: no
 * `token`, no `requesterEmail`, no `authorEmail`. lib/support.ts's
 * forRequester() returns exactly the shape below, so a page that forgets to
 * scrub gets a type error rather than a leak. The admin page passes the same
 * scrubbed shape and renders the sensitive fields itself, in its own strip,
 * where the permission that authorized them is obvious.
 *
 * `onReply` is injected rather than imported, because the surfaces post
 * through different credentials — a token or the owner's session for the
 * requester, a support.manage assertion for the team — and the component must
 * not be the thing that decides which. It just calls what it was handed.
 */

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
  staffView = false,
  controls,
  startNewHref,
  onReply,
}: {
  ticket: TicketThreadTicket;
  replies: TicketThreadReply[];
  /** False on a closed ticket for the requester. */
  canReply: boolean;
  /** True on the admin surface: enables the internal-note toggle. */
  staffView?: boolean;
  controls?: React.ReactNode;
  /** Requester surfaces: where "start a new one" goes once a request is closed. */
  startNewHref?: string;
  onReply: (args: { body: string; internal: boolean }) => Promise<void>;
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
          {staffView ? ticket.status.replace(/_/g, " ") : STATUS_LABELS[ticket.status]}
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
      </article>

      <h2 className="mt-8 text-[11px] font-mono font-medium uppercase tracking-[0.2em] text-ink-faint">
        {replies.length === 0
          ? "No replies yet"
          : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
      </h2>

      {replies.length === 0 && !finished && (
        <p className="mt-3 text-sm text-ink-soft">
          {staffView
            ? "Nobody has answered this yet."
            : "A human reads every request. You'll get an email the moment someone replies — you don't need to check back."}
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
            </li>
          ))}
        </ul>
      )}

      {canReply ? (
        <ReplyComposer
          onReply={onReply}
          staffView={staffView}
          resolved={ticket.status === "resolved"}
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
      ) : (
        // Keyed on the status, not just on canReply. The other way a composer
        // is withheld is a read-only viewer — someone holding support.view
        // without support.manage — and telling them an open ticket is "closed
        // and isn't accepting replies" would be a false statement about the
        // ticket rather than a true one about their permissions.
        staffView && (
          <p className="mt-6 flex items-center gap-2 text-sm text-ink-faint">
            <Lock className="h-3.5 w-3.5" />
            You have read access to this request. Answering it needs the
            &ldquo;Answer support requests&rdquo; permission.
          </p>
        )
      )}
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
  staffView,
  resolved,
}: {
  onReply: (args: { body: string; internal: boolean }) => Promise<void>;
  staffView: boolean;
  resolved: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();

  function send() {
    setErr(undefined);
    const text = body.trim();
    if (!text) return;
    start(async () => {
      try {
        await onReply({ body: text, internal });
        setBody("");
        setInternal(false);
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <div className="mt-6">
      <label htmlFor="ticket-reply" className="sr-only">
        Your reply
      </label>
      <Textarea
        id="ticket-reply"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          staffView
            ? internal
              ? "A note for the team. The requester never sees this."
              : "Reply to the requester. This emails them."
            : resolved
              ? "Still not sorted? Reply here and it reopens."
              : "Add anything else that would help…"
        }
        maxLength={REPLY_BODY_MAX}
        rows={4}
        error={err}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <FieldError id="ticket-reply-error">{err}</FieldError>
        <div className="ml-auto flex items-center gap-3">
          {staffView && (
            // A checkbox rather than a second button, because the distinction
            // it draws — "does this email a real person" — should be visible
            // while the message is being typed, not decided at the last click.
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={internal}
                onChange={(e) => setInternal(e.target.checked)}
                className="h-3.5 w-3.5 accent-amber-500"
              />
              Internal note
            </label>
          )}
          <Button size="sm" onClick={send} disabled={pending || !body.trim()}>
            {pending
              ? "Sending…"
              : staffView && internal
                ? "Save note"
                : staffView
                  ? "Send reply"
                  : "Send"}
          </Button>
        </div>
      </div>
      {staffView && !internal && (
        <p className="mt-2 text-xs text-ink-faint">
          Sending emails the requester and moves this out of the queue.
        </p>
      )}
    </div>
  );
}
