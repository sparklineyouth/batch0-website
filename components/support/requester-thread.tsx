"use client";
import { TicketThread, type TicketThreadReply, type TicketThreadTicket } from "@/components/support/ticket-thread";
import { replyToSupportTicket } from "@/app/support/actions";

/**
 * The requester's half of the thread: TicketThread wired to the token-
 * authorized reply action.
 *
 * This exists only to own the credential. The token is already in the address
 * bar of the page rendering this, so holding it as a prop discloses nothing
 * new — but keeping it in one small client component means the shared
 * TicketThread never takes a credential at all, and the admin surface can
 * mount the same component with a completely different authorization without
 * either path being able to borrow the other's.
 *
 * The action returns a result rather than throwing, so this converts a failure
 * back into a throw — that is the contract TicketThread's composer expects,
 * and it routes the real message through getActionError().
 */
export function RequesterThread({
  ticket,
  replies,
  canReply,
  token,
}: {
  ticket: TicketThreadTicket;
  replies: TicketThreadReply[];
  canReply: boolean;
  token: string;
}) {
  return (
    <TicketThread
      ticket={ticket}
      replies={replies}
      canReply={canReply}
      startNewHref="/support"
      onReply={async ({ body }) => {
        const form = new FormData();
        form.set("token", token);
        form.set("body", body);
        const res = await replyToSupportTicket(null, form);
        if (!res.ok) throw new Error(res.error);
      }}
    />
  );
}
