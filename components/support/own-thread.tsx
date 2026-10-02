"use client";
import { markOwnTicketSolved, replyToOwnTicket } from "@/app/support/actions";
import { AttachmentList } from "@/components/support/attachment-list";
import { AttachmentPicker } from "@/components/support/attachment-picker";
import {
  MarkSolvedButton,
  TicketThread,
  filesOn,
  type TicketThreadFiles,
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
 *
 * Files go the same way: links through the session download route, uploads
 * minted for "the signed-in owner of this reference" — both re-checked on the
 * server at the moment they're used.
 */
export function OwnThread({
  ticket,
  replies,
  files,
  canReply,
  canMarkSolved,
}: {
  ticket: TicketThreadTicket;
  replies: TicketThreadReply[];
  /** The thread's files that aren't internal, split by message. */
  files?: TicketThreadFiles;
  canReply: boolean;
  canMarkSolved: boolean;
}) {
  return (
    <TicketThread
      ticket={ticket}
      replies={replies}
      canReply={canReply}
      startNewHref="/dashboard/support/new"
      controls={
        canMarkSolved ? (
          <MarkSolvedButton
            onSolve={() => {
              const form = new FormData();
              form.set("reference", ticket.reference);
              return markOwnTicketSolved(null, form);
            }}
          />
        ) : undefined
      }
      renderFiles={(replyId) => (
        <AttachmentList items={filesOn(files, replyId)} access={{ kind: "session" }} />
      )}
      renderAttach={(slot) => (
        <AttachmentPicker scope={{ kind: "own", reference: ticket.reference }} {...slot} />
      )}
      onReply={async ({ body, attachments }) => {
        const form = new FormData();
        form.set("reference", ticket.reference);
        form.set("body", body);
        form.set("attachments", attachments);
        const res = await replyToOwnTicket(null, form);
        if (!res.ok) throw new Error(res.error);
        return { rejectedFiles: res.attachments?.rejected };
      }}
    />
  );
}
