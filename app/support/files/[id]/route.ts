import { getViewer } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { isUuid, mayDownloadAttachment } from "@/lib/support-attachment-rules";
import {
  attachmentNotFound,
  attachmentRedirect,
  attachmentUnavailable,
  findAttachmentForSession,
  signAttachmentUrl,
} from "@/lib/support-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open one support attachment, for a signed-in viewer.
 *
 *   /support/files/<attachment id>  → 302 to a ten-minute signed URL
 *
 * Every file chip on a signed-in surface points here — the dashboard and app
 * threads, and the admin desktop and phone queues — rather than at Storage,
 * the move /dashboard/resources/open/[id] makes: the URL is signed at the
 * moment of the click, after the check, so a page left open for a day never
 * hands out a dead link, and a link copied off the page is worthless alone.
 *
 * Who may (mayDownloadAttachment): staff who can see the ticket — support.view
 * or support.manage, plus support.sensitive on a confidential concern — get
 * any file on it, internal ones included; the ticket's owner gets the files
 * that aren't internal. Everyone else, signed out included, gets the same 404
 * as a file that doesn't exist: the existence of a stranger's support file is
 * not something to confirm.
 *
 * Deliberately NOT under /dashboard: the pending-fine block and the
 * student.dashboard gate in middleware both cover /dashboard, and neither
 * should stand between a person and the receipt they attached to a refund
 * request. Session-read through the request-cached getViewer(), which is the
 * right trade for a read (lib/auth.ts).
 */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  if (!isUuid(id)) return attachmentNotFound();

  const viewer = await getViewer();
  if (!viewer) return attachmentNotFound();

  const found = await findAttachmentForSession(id);
  if (!found) return attachmentNotFound();

  const allowed = mayDownloadAttachment(
    {
      userId: viewer.profile.id,
      canView: can(viewer.caps, "support.view") || can(viewer.caps, "support.manage"),
      canSeeSensitive: can(viewer.caps, "support.sensitive"),
    },
    found.ticket,
    found.attachment,
  );
  if (!allowed) return attachmentNotFound();

  const url = await signAttachmentUrl(found);
  if (!url) return attachmentUnavailable();
  return attachmentRedirect(url);
}
