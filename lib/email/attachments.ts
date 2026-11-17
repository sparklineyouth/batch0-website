import "server-only";

import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  EMAIL_ATTACHMENT_BUCKET,
  EMAIL_ATTACHMENT_MAX_BYTES,
  EMAIL_ATTACHMENT_MAX_FILES,
  EMAIL_ATTACHMENT_ORPHAN_TTL_MS,
  EMAIL_ATTACHMENT_TOTAL_MAX_BYTES,
  buildEmailAttachmentPath,
  contentTypeForName,
  emailAttachmentPrefix,
  isOwnEmailAttachmentPath,
  isWellFormedEmailAttachmentPath,
  nameForOutboundFile,
  type EmailUploadRequestFile,
  type MintedEmailUpload,
  type OutboundAttachment,
  type StagedEmailAttachment,
} from "@/lib/email-attachment-rules";
import { isBlockedContentType } from "@/lib/file-name-rules";

/**
 * The server half of email attachments: mint an upload URL, turn staged paths
 * into bytes a transport can send, and reclaim what was never sent.
 *
 * Everything in lib/email-attachment-rules.ts is a rule about data. Everything
 * here touches storage, and so everything here re-checks what that module
 * could only take the browser's word for. The division is the same one
 * lib/support-attachments.ts draws, and for the same reason: the picker's
 * checks exist to give an honest person a fast, specific error, and are worth
 * exactly nothing against a tampered request.
 */

type StoredObject = { size: number; mimetype: string };

/**
 * What storage holds at each path: its metadata, null when there is nothing
 * there, or "error" when the lookup itself failed — which is NOT "the file
 * doesn't exist", and is never treated as grounds to drop or delete anything.
 *
 * Lifted from readStoredObjects in lib/support-attachments.ts, which reads the
 * other bucket the same way. Not shared: that one is bound to the support
 * bucket and to a ticket's authorization, and threading a bucket argument
 * through it to save fifteen lines would couple two features that have no
 * reason to move together.
 */
async function readStoredObjects(
  admin: ReturnType<typeof createAdminClient>,
  paths: string[],
): Promise<Map<string, StoredObject | null | "error">> {
  const bucket = admin.storage.from(EMAIL_ATTACHMENT_BUCKET);
  const out = new Map<string, StoredObject | null | "error">();
  await Promise.all(
    paths.map(async (path) => {
      const slash = path.lastIndexOf("/");
      const dir = path.slice(0, slash);
      const name = path.slice(slash + 1);
      try {
        const { data, error } = await bucket.list(dir, { search: name, limit: 5 });
        if (error) {
          out.set(path, "error");
          return;
        }
        const hit = (data ?? []).find((o) => o.name === name) as
          | { metadata?: { size?: unknown; mimetype?: unknown } | null }
          | undefined;
        out.set(
          path,
          hit
            ? {
                size: Number(hit.metadata?.size ?? 0),
                mimetype: String(hit.metadata?.mimetype ?? ""),
              }
            : null,
        );
      } catch {
        out.set(path, "error");
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/**
 * One signed upload URL per file, each scoped to a path this function built.
 *
 * The path is the whole of the authorization the URL carries, so it is never
 * the browser's choice: `c/<the sender's uid>/<fresh uuid>-<sanitized name>`.
 * A caller who tampers with the path gets a token that does not match it and
 * storage refuses the write.
 *
 * Returns null for any single file whose mint fails rather than throwing, so
 * one storage hiccup doesn't lose the other four; the action reports the
 * partial result.
 */
export async function mintAttachmentUploads(
  userId: string,
  files: EmailUploadRequestFile[],
): Promise<MintedEmailUpload[]> {
  const admin = createAdminClient();
  const bucket = admin.storage.from(EMAIL_ATTACHMENT_BUCKET);
  const prefix = emailAttachmentPrefix(userId);

  const minted = await Promise.all(
    files.map(async (file) => {
      const path = buildEmailAttachmentPath(prefix, randomUUID(), file.name);
      try {
        const { data, error } = await bucket.createSignedUploadUrl(path);
        if (error || !data?.token) {
          console.error("[email-attachments] mint failed", error?.message);
          return null;
        }
        return { path, token: data.token } satisfies MintedEmailUpload;
      } catch (err: any) {
        console.error("[email-attachments] mint threw", err?.message ?? err);
        return null;
      }
    }),
  );
  return minted.filter((m): m is MintedEmailUpload => m !== null);
}

// ---------------------------------------------------------------------------
// Resolving to bytes
// ---------------------------------------------------------------------------

export type ResolveResult =
  | { ok: true; attachments: OutboundAttachment[] }
  | { ok: false; error: string };

/**
 * Turn the draft's staged paths into MIME parts, or refuse the send.
 *
 * This is the enforcement point, and it is deliberately all-or-nothing: an
 * email that silently goes out without the PDF it was written around is worse
 * than one that doesn't go out at all, because nobody finds out until the
 * recipient asks. Every refusal below therefore fails the whole send with a
 * sentence the sender can act on.
 *
 * What it re-checks, none of which the browser is trusted for:
 *  - the path is this sender's (isOwnEmailAttachmentPath);
 *  - the object exists, and is not empty;
 *  - its REAL size, read from storage, is within the per-file and total caps
 *    — the browser's claimed size is never used for anything here;
 *  - storage's recorded type is not active content. An allowed extension
 *    cannot honestly carry text/html, so a match means a tampered upload.
 *
 * The Content-Type that ships is derived from the file name's extension
 * (contentTypeForName), not from storage's guess: the recipient's mail client
 * acts on it, and a .docx delivered as application/octet-stream downloads as
 * an unknown blob instead of opening in Word.
 */
export async function resolveAttachments(
  staged: StagedEmailAttachment[],
  /**
   * The sender whose folder these paths must be in, or null to skip only
   * that one check.
   *
   * null exists for exactly one caller: the outbox drainer. A queued row's
   * `user_id` is the RECIPIENT, not the sender, so there is no sender
   * identity to compare against at send time — and re-deriving one from the
   * path would be circular, since the path is the thing being checked. What
   * makes null safe is that the row was written by sendCompose, which ran
   * this function WITH the sender's id before enqueuing anything: a path only
   * reaches the outbox after it has been proved to belong to the person who
   * scheduled the email.
   *
   * Every other check below still runs on the queued path. null narrows this
   * to "already authorized", not "unchecked".
   */
  ownerId: string | null,
): Promise<ResolveResult> {
  if (staged.length === 0) return { ok: true, attachments: [] };
  if (staged.length > EMAIL_ATTACHMENT_MAX_FILES) {
    return {
      ok: false,
      error: `You can attach up to ${EMAIL_ATTACHMENT_MAX_FILES} files to one email.`,
    };
  }

  for (const item of staged) {
    const acceptable =
      ownerId === null
        ? isWellFormedEmailAttachmentPath(item.path)
        : isOwnEmailAttachmentPath(item.path, ownerId);
    if (!acceptable) {
      // Either a tampered draft or a file staged by a different admin. Both
      // are the same answer, and neither gets a hint about which.
      return {
        ok: false,
        error: "One of those attachments isn't available any more. Remove it and attach the file again.",
      };
    }
  }

  const admin = createAdminClient();
  const stored = await readStoredObjects(
    admin,
    staged.map((s) => s.path),
  );

  let total = 0;
  for (const item of staged) {
    const info = stored.get(item.path);
    if (info === "error") {
      return {
        ok: false,
        error: "We couldn't reach file storage to read the attachments. Nothing was sent — try again in a moment.",
      };
    }
    if (!info) {
      return {
        ok: false,
        error: `${item.name} is no longer in storage. Attach it again before sending.`,
      };
    }
    if (info.size <= 0) {
      return { ok: false, error: `${item.name} uploaded as an empty file. Attach it again.` };
    }
    if (info.size > EMAIL_ATTACHMENT_MAX_BYTES) {
      return {
        ok: false,
        error: `${item.name} is larger than the ${Math.round(
          EMAIL_ATTACHMENT_MAX_BYTES / (1024 * 1024),
        )} MB limit.`,
      };
    }
    if (isBlockedContentType(info.mimetype)) {
      return {
        ok: false,
        error: `${item.name} isn't the kind of file it claimed to be. Remove it and attach the file again.`,
      };
    }
    total += info.size;
  }
  if (total > EMAIL_ATTACHMENT_TOTAL_MAX_BYTES) {
    return {
      ok: false,
      error: `Those attachments come to more than the ${Math.round(
        EMAIL_ATTACHMENT_TOTAL_MAX_BYTES / (1024 * 1024),
      )} MB an email can carry. Remove one and send again.`,
    };
  }

  const attachments: OutboundAttachment[] = [];
  for (const item of staged) {
    const { data, error } = await admin.storage
      .from(EMAIL_ATTACHMENT_BUCKET)
      .download(item.path);
    if (error || !data) {
      console.error("[email-attachments] download failed", item.path, error?.message);
      return {
        ok: false,
        error: `We couldn't read ${item.name} back out of storage. Nothing was sent — try again.`,
      };
    }
    const filename = nameForOutboundFile(item.name, item.path);
    attachments.push({
      filename,
      content: Buffer.from(await data.arrayBuffer()).toString("base64"),
      contentType: contentTypeForName(filename),
    });
  }
  return { ok: true, attachments };
}

// ---------------------------------------------------------------------------
// Reclaiming what was never sent
// ---------------------------------------------------------------------------

/**
 * Delete staged uploads nobody is going to send.
 *
 * Called once per drain from /api/cron/email-queue, which runs every five
 * minutes. An attachment is only needed until its email leaves: an immediate
 * send is done with it in seconds, and a scheduled send needs it until its
 * send time. So the rule is "older than a day AND not referenced by an unsent
 * outbox row", and the second half is why the partial GIN index in migration
 * 0112 exists.
 *
 * Deliberately conservative in three places, because the cost of deleting a
 * file someone is about to send is an email that goes out without its
 * attachment, and the cost of keeping one an extra day is nothing:
 *  - a storage or database error aborts the sweep rather than falling back to
 *    "nothing is referenced", which would delete everything;
 *  - only objects whose age we can actually read are considered;
 *  - it is capped per run, so a backlog drains over several runs instead of
 *    one request timing out halfway through a delete.
 */
const SWEEP_LIMIT = 200;

export async function sweepOrphanedAttachments(
  now: number = Date.now(),
): Promise<{ deleted: number; skipped: number }> {
  const admin = createAdminClient();

  // Which paths an unsent email still points at. One query, small result:
  // the index is partial on exactly these rows.
  const referenced = new Set<string>();
  const { data: pending, error: pendingError } = await admin
    .from("email_outbox")
    .select("attachments")
    .eq("status", "pending")
    .neq("attachments", "[]");
  if (pendingError) {
    console.error("[email-attachments] sweep aborted; outbox unreadable", pendingError.message);
    return { deleted: 0, skipped: 0 };
  }
  for (const row of pending ?? []) {
    const list = Array.isArray((row as any).attachments) ? (row as any).attachments : [];
    for (const a of list) {
      if (a && typeof a.path === "string") referenced.add(a.path);
    }
  }

  const bucket = admin.storage.from(EMAIL_ATTACHMENT_BUCKET);
  const { data: senders, error: sendersError } = await bucket.list("c", { limit: 1000 });
  if (sendersError) {
    console.error("[email-attachments] sweep aborted; bucket unreadable", sendersError.message);
    return { deleted: 0, skipped: 0 };
  }

  const stale: string[] = [];
  let skipped = 0;
  for (const sender of senders ?? []) {
    if (stale.length >= SWEEP_LIMIT) break;
    const dir = `c/${sender.name}`;
    const { data: objects, error } = await bucket.list(dir, { limit: 1000 });
    if (error) {
      console.error("[email-attachments] sweep: cannot list", dir, error.message);
      skipped += 1;
      continue;
    }
    for (const o of objects ?? []) {
      if (stale.length >= SWEEP_LIMIT) break;
      const path = `${dir}/${o.name}`;
      if (referenced.has(path)) continue;
      const createdAt = Date.parse(
        String((o as any).created_at ?? (o as any).updated_at ?? ""),
      );
      // An object whose age we can't read is left alone, not guessed at.
      if (!Number.isFinite(createdAt)) {
        skipped += 1;
        continue;
      }
      if (now - createdAt < EMAIL_ATTACHMENT_ORPHAN_TTL_MS) continue;
      stale.push(path);
    }
  }

  if (stale.length === 0) return { deleted: 0, skipped };
  const { error: removeError } = await bucket.remove(stale);
  if (removeError) {
    console.error("[email-attachments] sweep: remove failed", removeError.message);
    return { deleted: 0, skipped };
  }
  return { deleted: stale.length, skipped };
}
