import {
  attachmentNotFound,
  attachmentRedirect,
  attachmentUnavailable,
  findAttachmentForToken,
  signAttachmentUrl,
} from "@/lib/support-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open one support attachment, for the holder of an emailed thread link.
 *
 *   /support/t/<token>/files/<attachment id>  → 302 to a ten-minute signed URL
 *
 * The token is the credential, exactly as on the thread page above this
 * route: no session, because the link has to work weeks later in whatever
 * browser opened the mail. It reaches only files on THAT ticket that aren't
 * internal — the files the requester can see on their own thread — and
 * everything else is the same 404, malformed token included.
 *
 * The URL carries the token, so it is handled like the thread page's own:
 * under /support/t/ it is already disallowed in robots.txt and blind to
 * analytics (lib/payment-privacy.ts isSecretUrlPath matches the prefix), and
 * the redirect is sent with `Referrer-Policy: no-referrer` and no-store, so
 * neither the hop to the storage host nor any cache keeps a copy of it.
 */
export async function GET(
  _req: Request,
  props: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id } = await props.params;

  // findAttachmentForToken checks both shapes before any database round trip.
  const found = await findAttachmentForToken(token, id);
  if (!found) return attachmentNotFound();

  const url = await signAttachmentUrl(found);
  if (!url) return attachmentUnavailable();
  return attachmentRedirect(url);
}
