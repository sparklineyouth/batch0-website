"use client";
import {
  TicketThread,
  type TicketThreadReply,
  type TicketThreadTicket,
} from "@/components/support/ticket-thread";
import { replyAsStaff } from "@/app/admin/support/actions";

/**
 * The team's half of the thread: the same TicketThread the requester sees,
 * wired to the permission-authorized reply action and with the internal-note
 * composer enabled.
 *
 * The twin of components/support/requester-thread.tsx, and the reason both
 * exist: the shared component never takes a credential, so the two
 * authorization modes — a token, a support.manage assertion — cannot borrow
 * each other's.
 */
export function StaffThread({
  ticket,
  replies,
  ticketId,
  canManage,
  controls,
}: {
  ticket: TicketThreadTicket;
  replies: TicketThreadReply[];
  ticketId: string;
  canManage: boolean;
  controls?: React.ReactNode;
}) {
  return (
    <TicketThread
      ticket={ticket}
      replies={replies}
      // A read-only viewer (support.view without support.manage) sees the whole
      // thread and gets no composer. The action would refuse them anyway.
      canReply={canManage}
      staffView
      controls={controls}
      onReply={async ({ body, internal }) => {
        const res = await replyAsStaff({ ticketId, body, internal });
        if (!res.ok) throw new Error(res.error);
      }}
    />
  );
}
