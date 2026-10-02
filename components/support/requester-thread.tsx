"use client";
import {
  MarkSolvedButton,
  TicketThread,
  filesOn,
  type TicketThreadFiles,
  type TicketThreadReply,
  type TicketThreadTicket,
} from "@/components/support/ticket-thread";
import { AttachmentList } from "@/components/support/attachment-list";
import { AttachmentPicker } from "@/components/support/attachment-picker";
import { markTicketSolvedByToken, replyToSupportTicket } from "@/app/support/actions";

/**
 * The requester's half of the thread: TicketThread wired to the token-
 * authorized reply action.
 *
 * This exists only to own the credential. The token is already in the address
 * bar of the page rendering this, so holding it as a prop discloses nothing
 * new — but keeping it in one small client component means the shared
 * TicketThread never takes a credential at all, and the signed-in owner's
 * page (own-thread.tsx) can mount the same component with the session
 * instead, without either path being able to borrow the other's. The file
 * links (the token download route) and uploads (minted against the token) are
 * built here for the same reason.
 *
 * The action returns a result rather than throwing, so this converts a failure
 * back into a throw — that is the contract TicketThread's composer expects,
 * and it routes the real message through getActionError().
 */
export function RequesterThread({
  ticket,
  replies,
  files,
  canReply,
  canMarkSolved = false,
  token,
}: {
  ticket: TicketThreadTicket;
  replies: TicketThreadReply[];
  /** The thread's files that aren't internal, split by message. */
  files?: TicketThreadFiles;
  canReply: boolean;
  canMarkSolved?: boolean;
  token: string;
}) {
  return (
    <TicketThread
      ticket={ticket}
      replies={replies}
      canReply={canReply}
      startNewHref="/support"
      // The emailed link is the only page a requester without an account
      // has — a parent the team logged a request for — so it carries the
      // same "This is solved" as the signed-in thread.
      controls={
        canMarkSolved ? (
          <MarkSolvedButton
            onSolve={() => {
              const form = new FormData();
              form.set("token", token);
              return markTicketSolvedByToken(null, form);
            }}
          />
        ) : undefined
      }
      renderFiles={(replyId) => (
        <AttachmentList items={filesOn(files, replyId)} access={{ kind: "token", token }} />
      )}
      renderAttach={(slot) => <AttachmentPicker scope={{ kind: "token", token }} {...slot} />}
      onReply={async ({ body, attachments }) => {
        const form = new FormData();
        form.set("token", token);
        form.set("body", body);
        form.set("attachments", attachments);
        const res = await replyToSupportTicket(null, form);
        if (!res.ok) throw new Error(res.error);
        return { rejectedFiles: res.attachments?.rejected };
      }}
    />
  );
}
