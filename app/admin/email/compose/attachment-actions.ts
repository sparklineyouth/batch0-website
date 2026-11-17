"use server";

import { assertPermission } from "@/lib/server-guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { mintAttachmentUploads } from "@/lib/email/attachments";
import {
  validateEmailUploadRequest,
  type EmailMintResult,
} from "@/lib/email-attachment-rules";

/**
 * Step 1 of an email attachment: check the permission, build the storage path
 * ourselves, and hand back one-shot signed upload URLs. The bytes then go
 * straight from the browser into the private bucket — a server action body
 * caps at 1 MB, and a 10 MB PDF cannot travel through one.
 *
 * The path is the whole of the authorization each URL carries, so it is never
 * the browser's choice: `c/<the caller's uid>/<fresh uuid>-<sanitized name>`.
 * A signed upload URL can't carry a size or type limit of its own, so the
 * checks here run on what the browser SAYS about each file — honest people
 * get an instant, specific error. The enforcement is resolveAttachments
 * (lib/email/attachments.ts), which reads the real size and type back out of
 * storage before any of it is encoded into a message.
 *
 * Returns `{ ok, uploads | error }` rather than throwing, for the reason
 * lib/action-result.ts gives: a thrown message is stripped in production, and
 * "that file is 14 MB" is worth showing.
 */

/**
 * Attachments ride on `email.send`, not a permission of their own.
 *
 * Someone who can send mail as batch0 can already put any link they like in
 * the body; a file is not a larger grant than that. A second permission would
 * only create the state where an admin can send the email but not the thing
 * the email is about.
 */
const PERMISSION = "email.send";

/**
 * Minting is cheap, but it writes an object key per call and a signed URL is
 * a write credential. Twelve picks a minute is far past how fast a person
 * composes and far below anything that costs us.
 */
const RATE_LIMIT = 12;
const RATE_WINDOW_SECONDS = 60;

export async function mintEmailAttachmentUploads(
  files: unknown,
  /**
   * Bytes already staged on this draft. Sent by the picker so the total can
   * be enforced across separate picks — five one-file picks would otherwise
   * sail past a limit only ever checked one batch at a time. Advisory, like
   * every other number the browser supplies here: resolveAttachments measures
   * the real total before the send.
   */
  alreadyAttachedBytes: unknown = 0,
): Promise<EmailMintResult> {
  const { userId } = await assertPermission(PERMISSION);

  const already =
    typeof alreadyAttachedBytes === "number" && Number.isFinite(alreadyAttachedBytes)
      ? Math.max(0, alreadyAttachedBytes)
      : 0;

  const parsed = validateEmailUploadRequest(files, already);
  if (!parsed.ok) return parsed;

  const limit = await checkRateLimit({
    kind: "email-attachment-mint",
    identifier: userId,
    limit: RATE_LIMIT,
    windowSeconds: RATE_WINDOW_SECONDS,
  });
  if (!limit.ok) {
    return { ok: false, error: "That's a lot of uploads at once. Wait a moment and try again." };
  }

  const uploads = await mintAttachmentUploads(userId, parsed.files);
  if (uploads.length !== parsed.files.length) {
    return {
      ok: false,
      error: "We couldn't start that upload. Try again in a moment.",
    };
  }
  return { ok: true, uploads };
}
