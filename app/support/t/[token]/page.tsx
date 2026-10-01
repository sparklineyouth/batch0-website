import Link from "next/link";
import { notFound } from "next/navigation";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { getPublicSiteConfig } from "@/lib/site-config";
import {
  forRequester,
  formatReceivedAt,
  getSupportTicketByToken,
  listTicketReplies,
} from "@/lib/support";
import { canRequesterReply } from "@/lib/support-access";
import { RequesterThread } from "@/components/support/requester-thread";

/**
 * The requester's own thread. Authorization is the token in the URL and
 * nothing else — there is no session here on purpose, because the link has to
 * work weeks later out of an email, in whatever browser opened the mail.
 *
 * Three disciplines follow from that, all deliberate:
 *  - noindex/nofollow, and absent from app/sitemap.ts. A crawler must never
 *    hold one of these URLs.
 *  - the title is fixed. A per-ticket title would mean reading the ticket
 *    before deciding whether the reader may see it, and a support request's
 *    subject is private — "Refund for tuition" in a browser tab is a
 *    disclosure.
 *  - "no such ticket" and "not your ticket" are the same 404 by construction.
 *    There is no second credential to be wrong about, so a distinct error
 *    would only tell a prober their guess was close.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your support request · batch0",
  robots: { index: false, follow: false },
};

export default async function SupportThreadPage(props: {
  params: Promise<{ token: string }>;
}) {
  const params = await props.params;
  const ticket = await getSupportTicketByToken(params.token);
  if (!ticket) notFound();

  const [replies, config] = await Promise.all([
    // Internal notes are staff-only. The default is already false; passing it
    // explicitly because this is the one call site where getting it wrong
    // would publish the team's private notes to the person they are about.
    listTicketReplies(ticket.id, { includeInternal: false }),
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
          replies={replies.map((r) => {
            const s = forRequester(r);
            return {
              id: s.id,
              authorName: s.authorName ?? "You",
              body: s.body,
              isStaff: s.isStaff,
              isInternal: s.isInternal,
              createdAt: s.createdAt,
            };
          })}
          canReply={canRequesterReply(ticket)}
        />

        <p className="mt-10 border-t border-line pt-5 text-xs text-ink-faint">
          This page is private to whoever has its link — treat it like the
          email it came in. Your other requests are at{" "}
          <Link href="/dashboard/support" prefetch={false} className="link-ink">
            your support page
          </Link>
          , and you can start a new one at{" "}
          <Link href="/support" prefetch={false} className="link-ink">
            batch0.org/support
          </Link>
          .
        </p>
      </main>
      <Footer config={config} />
    </div>
  );
}
