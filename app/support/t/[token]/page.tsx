import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { getPublicSiteConfig } from "@/lib/site-config";
import {
  forRequester,
  formatReceivedAt,
  getSupportTicketByToken,
  listTicketReplies,
  requesterThreadPath,
} from "@/lib/support";
import { canRequesterMarkSolved, canRequesterReply } from "@/lib/support-access";
import { listAttachments } from "@/lib/support-attachments";
import { groupAttachmentsByReply } from "@/lib/support-attachment-rules";
import { RequesterThread } from "@/components/support/requester-thread";

/**
 * The requester's own thread. Authorization is the token in the URL and
 * nothing else — there is no session here on purpose, because the link has to
 * work weeks later out of an email, in whatever browser opened the mail.
 *
 * The disciplines that follow from that, all deliberate:
 *  - noindex/nofollow, and absent from app/sitemap.ts. A crawler must never
 *    hold one of these URLs.
 *  - no Referer. Every link off this page would otherwise hand the token to
 *    the next site in its Referer header — the same rule as /pay.
 *  - the title is fixed. A per-ticket title would mean reading the ticket
 *    before deciding whether the reader may see it, and a support request's
 *    subject is private — "Refund for tuition" in a browser tab is a
 *    disclosure.
 *  - "no such ticket" and "not your ticket" are the same 404 by construction
 *    (app/support/not-found.tsx). There is no second credential to be wrong
 *    about, so a distinct error would only tell a prober their guess was close.
 *  - nothing in the app navigates here client-side, and the links out of it
 *    are plain anchors: a soft navigation is a history entry analytics can
 *    see, and on this route the path is the secret.
 *  - the request's owner, signed in, is sent to their own thread instead
 *    (/dashboard/support/<reference>): the same conversation, authorized by
 *    the session, with the token out of the address bar.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your support request · batch0",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SupportThreadPage(props: {
  params: Promise<{ token: string }>;
}) {
  const params = await props.params;
  const [ticket, user] = await Promise.all([
    getSupportTicketByToken(params.token),
    getUser(),
  ]);
  if (!ticket) notFound();
  // Only the owner: anyone else signed in (a parent on their own account, a
  // teammate the link was forwarded to) keeps the token page — the dashboard
  // thread would be a 404 for them.
  if (user && ticket.userId && user.id === ticket.userId) {
    redirect(requesterThreadPath(ticket.reference));
  }

  const [replies, attachments, config] = await Promise.all([
    // Internal notes are staff-only, and so are files on them. The defaults
    // are already false; passing them explicitly because this is the one call
    // site where getting it wrong would publish the team's private notes to
    // the person they are about.
    listTicketReplies(ticket.id, { includeInternal: false }),
    listAttachments(ticket.id, { includeInternal: false }),
    getPublicSiteConfig(),
  ]);

  const scrubbed = forRequester(ticket);

  return (
    <div className="min-h-screen bg-paper">
      <Navbar />
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-2xl px-6 pb-20 pt-12"
      >
        <RequesterThread
          token={ticket.token}
          ticket={{
            id: scrubbed.id,
            reference: scrubbed.reference,
            subject: scrubbed.subject,
            body: scrubbed.body,
            category: scrubbed.category,
            status: scrubbed.status,
            createdAt: scrubbed.createdAt,
            receivedAtLabel: formatReceivedAt(scrubbed.receivedAt),
            requesterName: scrubbed.requesterName,
            accountName: scrubbed.accountName,
          }}
          replies={replies
            // Belt and braces with includeInternal: false above.
            .filter((r) => !r.isInternal)
            .map((r) => {
              const s = forRequester(r);
              return {
                id: s.id,
                authorName:
                  s.author === "requester" ? "You" : (s.authorName ?? "The batch0 team"),
                body: s.body,
                isStaff: s.isStaff,
                isInternal: false,
                createdAt: s.createdAt,
              };
            })}
          // Belt and braces again; AttachmentList also drops internal files
          // whenever it is building token links.
          files={groupAttachmentsByReply(attachments.filter((a) => !a.isInternal))}
          canReply={canRequesterReply(ticket)}
          canMarkSolved={canRequesterMarkSolved(ticket)}
        />

        <p className="mt-10 border-t border-line pt-5 text-xs text-ink-faint">
          This page is private to whoever has its link — treat it like the
          email it came in. Your other requests are at{" "}
          <a href="/dashboard/support" className="link-ink">
            your support page
          </a>
          , and you can start a new one at{" "}
          <a href="/support" className="link-ink">
            batch0.org/support
          </a>
          .
        </p>
      </main>
      <Footer config={config} />
    </div>
  );
}
