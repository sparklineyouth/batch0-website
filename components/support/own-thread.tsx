"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { getActionError } from "@/lib/action-error";
import { markOwnTicketSolved, replyToOwnTicket } from "@/app/support/actions";
import {
  TicketThread,
  type TicketThreadReply,
  type TicketThreadTicket,
} from "@/components/support/ticket-thread";

/**
 * The signed-in owner's thread: TicketThread wired to the session actions.
 *
 * The third credential wrapper, beside RequesterThread (the emailed token) and
 * StaffThread (a support.manage assertion). It holds nothing secret — only
 * the reference, which grants nothing on its own; the actions re-read the
 * session and look the request up as that person's. No token ever reaches
 * this page, so none can leak out of it.
 */
export function OwnThread({
  ticket,
  replies,
  canReply,
  canMarkSolved,
}: {
  ticket: TicketThreadTicket;
  replies: TicketThreadReply[];
  canReply: boolean;
  canMarkSolved: boolean;
}) {
  return (
    <TicketThread
      ticket={ticket}
      replies={replies}
      canReply={canReply}
      startNewHref="/dashboard/support/new"
      controls={canMarkSolved ? <MarkSolved reference={ticket.reference} /> : undefined}
      onReply={async ({ body }) => {
        const form = new FormData();
        form.set("reference", ticket.reference);
        form.set("body", body);
        const res = await replyToOwnTicket(null, form);
        if (!res.ok) throw new Error(res.error);
      }}
    />
  );
}

/** "This is solved" — the requester's one status control on their own request. */
function MarkSolved({ reference }: { reference: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();

  function solve() {
    setErr(undefined);
    start(async () => {
      try {
        const form = new FormData();
        form.set("reference", reference);
        const res = await markOwnTicketSolved(null, form);
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
