import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import {
  forRequester,
  formatReceivedAt,
  getTicketForOwner,
  listTicketReplies,
} from "@/lib/support";
import { canRequesterMarkSolved, canRequesterReply } from "@/lib/support-access";
import { OwnThread } from "@/components/support/own-thread";

// Static title on purpose: a per-request title would have to read the ticket
// before the owner check, and a support request's subject is private.
export const metadata = { title: "Support request · batch0" };
export const dynamic = "force-dynamic";

/**
 * One of the viewer's own requests, authorized by their session — where the
 * dashboard list and every requester notification (staff replied, resolved)
 * point. Keyed on the reference, which grants nothing: the lookup is "this
 * reference AND this account", so a reference that exists but isn't theirs
 * is the same 404 as one that doesn't exist.
 *
 * The emailed /support/t/<token> link is the other door to the same thread;
 * nothing here ever renders or links to it.
 */
export default async function OwnSupportRequestPage(props: {
  params: Promise<{ reference: string }>;
}) {
  const params = await props.params;
  const { profile } = await requireViewer();
  // Normalized inside, so a lowercased or space-separated reference resolves.
  const ticket = await getTicketForOwner(profile.id, params.reference);
  if (!ticket) notFound();

  // Internal notes are staff-only. The default is already false; passing it
  // explicitly, and filtering again below, because this page is shown to the
  // person the team's notes are about.
  const replies = await listTicketReplies(ticket.id, { includeInternal: false });
  const t = forRequester(ticket);

  return (
    <div className="mx-auto max-w-3xl pb-16">
      <Link
        href="/dashboard/support"
        prefetch={false}
        className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Help &amp; support
      </Link>
      <div className="mt-4">
        <OwnThread
          ticket={{
            id: t.id,
            reference: t.reference,
            subject: t.subject,
            body: t.body,
            category: t.category,
            status: t.status,
            createdAt: t.createdAt,
            receivedAtLabel: formatReceivedAt(t.receivedAt),
            // Their own page: the byline is "You", like their follow-ups.
            requesterName: null,
            accountName: null,
          }}
          replies={replies
            .filter((r) => !r.isInternal)
            .map((r) => {
              const s = forRequester(r);
              return {
                id: s.id,
                authorName: s.author === "requester" ? "You" : (s.authorName ?? "The batch0 team"),
                body: s.body,
                isStaff: s.isStaff,
                isInternal: false,
                createdAt: s.createdAt,
              };
            })}
          canReply={canRequesterReply(ticket)}
          canMarkSolved={canRequesterMarkSolved(ticket)}
        />
      </div>
    </div>
  );
}
