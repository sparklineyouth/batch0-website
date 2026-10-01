import "server-only";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isTicketToken } from "@/lib/support-access";
import {
  ATTACHMENT_BUCKET,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_URL_TTL_SECONDS,
  allowedPrefixesFor,
  displayFileName,
  fileExtension,
  formatBytes,
  isAllowedExtension,
  isBlockedContentType,
  isPathUnderPrefix,
  isUuid,
  nameForStoredFile,
  normalizeContentType,
  opensInline,
  parseStagedAttachments,
  tokenMayDownloadAttachment,
  withDownloadName,
  type AttachmentUploader,
  type RejectedAttachment,
  type StagedAttachment,
  type SupportAttachment,
} from "@/lib/support-attachment-rules";

export type {
  AttachmentUploader,
  RejectedAttachment,
  StagedAttachment,
  SupportAttachment,
} from "@/lib/support-attachment-rules";

/**
 * Reads and writes for support-ticket attachments (migration 0090:
 * support_ticket_attachments + the private `support-attachments` bucket).
 *
 * Service role throughout, with explicit filters, like lib/support.ts — and
 * the bucket has no storage.objects policy at all (the call-recordings
 * precedent), so the service role is the only thing that can read or write a
 * byte of it. Every way in is a function below that has already decided who
 * is asking.
 *
 * Kept apart from lib/support.ts so the ticket data layer and the file layer
 * can change independently; this module needs nothing from a ticket but its
 * id, owner, sensitivity and token.
 *
 * MUST NOT be imported by anything a marketing page's module graph reaches,
 * for the reason lib/support.ts gives (createAdminClient forces no-store,
 * which un-prerenders a static page). components/support/attachment-list.tsx
 * imports only TYPES from here; its runtime rules come from the dependency-free
 * lib/support-attachment-rules.ts.
 */

const TABLE = "support_ticket_attachments";
const COLUMNS =
  "id, ticket_id, reply_id, file_name, content_type, size_bytes, is_staff, is_internal, created_at";
/** Five files a message; a thread with 500 files on it is far past any real one. */
const LIST_LIMIT = 500;

type AttachmentRow = {
  id: string;
  ticket_id: string;
  reply_id: string | null;
  file_name: string;
  content_type: string | null;
  size_bytes: number;
  is_staff: boolean;
  is_internal: boolean;
  created_at: string;
  storage_path?: string;
};

type AttachmentInsert = {
  ticket_id: string;
  reply_id: string | null;
  uploaded_by: string | null;
  is_staff: boolean;
  is_internal: boolean;
  storage_path: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
};

function toAttachment(r: AttachmentRow): SupportAttachment {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    replyId: r.reply_id ?? null,
    fileName: r.file_name,
    contentType: normalizeContentType(r.content_type),
    sizeBytes: Number(r.size_bytes) || 0,
    isStaff: r.is_staff === true,
    // Fail closed: anything but an explicit false reads as internal.
    isInternal: r.is_internal !== false,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Recording staged uploads
// ---------------------------------------------------------------------------

const REASON = {
  notYours: "That file wasn't uploaded for this request. Attach it again.",
  badType: "That kind of file can't be attached.",
  already: "That file is already attached.",
  cantCheck: "We couldn't check that file just now. Attach it again.",
  notUploaded: "That upload didn't finish. Attach it again.",
  empty: "That file is empty.",
  tooBig: `That file is over the ${formatBytes(ATTACHMENT_MAX_BYTES)} limit.`,
  cantSave: "We couldn't save that file. Attach it again.",
} as const;

export type RecordAttachmentsResult = {
  recorded: SupportAttachment[];
  rejected: RejectedAttachment[];
};

/**
 * Turn what a form posted (the picker's hidden input) into attachment rows on
 * a ticket — after checking every claim the browser made.
 *
 * Call it AFTER the ticket or reply exists (both are foreign keys), with an
 * `uploader` the calling action derived from the credential it checked: the
 * session's own user id, the ticket token, or a support.manage assertion.
 * Never from anything in the form.
 *
 * For each entry, in order:
 *  1. shape — parseStagedAttachments (array, ≤ 5, the right primitive types);
 *  2. path  — under a folder this uploader may record from (allowedPrefixesFor),
 *             in the exact grammar the mint action builds, allow-listed extension;
 *  3. once  — not already recorded on any ticket (storage_path is unique);
 *  4. bytes — the object exists, and storage's OWN size and type are within the
 *             cap and not active content (verifyNewUploads in
 *             app/challenges/[slug]/actions.ts is the model). The row records
 *             storage's size and type, never the browser's.
 * `is_staff` comes from the uploader, and `is_internal` can only be true for
 * staff — and is forced true when the reply is an internal note, whatever the
 * caller passed, so a file can never be more visible than the message it's on.
 *
 * Deletes the objects it rejected on their contents (too big, empty, active
 * content): they're inside a folder this uploader was entitled to, and no
 * later call could ever record them. Never deletes anything outside that
 * folder, or already recorded, or that it merely couldn't check — those may
 * be somebody's legitimate file.
 *
 * Never throws. The message it decorates has already been saved by then, so a
 * failure here must cost the attachment, not the message; the caller reports
 * `rejected` to the person.
 */
export async function recordAttachments(args: {
  ticketId: string;
  /** null = the files go on the original request. */
  replyId: string | null;
  uploader: AttachmentUploader;
  isInternal: boolean;
  staged: unknown;
}): Promise<RecordAttachmentsResult> {
  const { items, rejected } = parseStagedAttachments(args.staged);
  if (items.length === 0) return { recorded: [], rejected };
  try {
    // A copy, so a throw halfway through can't leave a file reported twice.
    return await record(args, items, [...rejected]);
  } catch (err) {
    console.error("[support-attachments] record failed", args.ticketId, err);
    return {
      recorded: [],
      rejected: [
        ...rejected,
        ...items.map((i) => ({ name: displayFileName(i.name), reason: REASON.cantSave })),
      ],
    };
  }
}

async function record(
  args: Parameters<typeof recordAttachments>[0],
  items: StagedAttachment[],
  rejected: RejectedAttachment[],
): Promise<RecordAttachmentsResult> {
  const refuse = (item: StagedAttachment, reason: string) =>
    rejected.push({ name: displayFileName(item.name), reason });
  const refuseAll = (list: StagedAttachment[], reason: string) => {
    for (const item of list) refuse(item, reason);
    return { recorded: [], rejected };
  };

  if (!isUuid(args.ticketId) || (args.replyId !== null && !isUuid(args.replyId))) {
    console.error("[support-attachments] not a ticket/reply id", args.ticketId, args.replyId);
    return refuseAll(items, REASON.cantSave);
  }

  const admin = createAdminClient();
  const isStaff = args.uploader.kind === "staff";
  let isInternal = isStaff && args.isInternal === true;

  // The calling action has already authorized the poster against this ticket;
  // this re-checks the one part of that a wrong argument could get wrong
  // silently. A signed-in requester's staging folder is theirs, so the ticket
  // their files go on must be theirs too.
  const { data: ticket, error: ticketError } = await admin
    .from("support_tickets")
    .select("id, user_id")
    .eq("id", args.ticketId)
    .maybeSingle();
  if (ticketError || !ticket) {
    console.error("[support-attachments] ticket not found", args.ticketId, ticketError?.message);
    return refuseAll(items, REASON.cantSave);
  }
  if (
    args.uploader.kind === "requester" &&
    args.uploader.via === "session" &&
    ticket.user_id !== args.uploader.userId
  ) {
    console.error("[support-attachments] session requester does not own", args.ticketId);
    return refuseAll(items, REASON.notYours);
  }

  // The reply has to be on this ticket and written by the same side as the
  // uploader — a requester's files can't be hung on the team's message, or the
  // other way round. And an internal note's files are internal, full stop.
  if (args.replyId) {
    const { data: reply, error } = await admin
      .from("support_ticket_replies")
      .select("ticket_id, is_staff, is_internal")
      .eq("id", args.replyId)
      .maybeSingle();
    if (error || !reply || reply.ticket_id !== args.ticketId || reply.is_staff !== isStaff) {
      console.error(
        "[support-attachments] reply does not match",
        args.ticketId,
        args.replyId,
        error?.message,
      );
      return refuseAll(items, REASON.cantSave);
    }
    isInternal = isStaff && (isInternal || reply.is_internal !== false);
  }

  // The path. A path outside the uploader's folders is refused and left
  // alone — it may well be someone else's upload, posted by a tampered form.
  const prefixes = allowedPrefixesFor(args.uploader, args.ticketId);
  const candidates: StagedAttachment[] = [];
  for (const item of items) {
    if (!isPathUnderPrefix(item.path, prefixes)) refuse(item, REASON.notYours);
    else if (!isAllowedExtension(fileExtension(item.path))) refuse(item, REASON.badType);
    else candidates.push(item);
  }
  if (candidates.length === 0) return { recorded: [], rejected };

  // Once. The unique index is the real guarantee (the insert below ignores
  // duplicates); this read is what lets us say so per file.
  const { data: existing, error: existingError } = await admin
    .from(TABLE)
    .select("storage_path")
    .in("storage_path", candidates.map((c) => c.path));
  if (existingError) {
    console.error("[support-attachments] existing-path read failed", existingError.message);
    return refuseAll(candidates, REASON.cantSave);
  }
  const taken = new Set((existing ?? []).map((r: { storage_path: string }) => r.storage_path));
  const fresh: StagedAttachment[] = [];
  for (const c of candidates) {
    if (taken.has(c.path)) refuse(c, REASON.already);
    else fresh.push(c);
  }

  // The bytes, as storage reports them.
  const stored = await readStoredObjects(admin, fresh.map((f) => f.path));
  const discard: string[] = [];
  const uploadedBy = isUuid(args.uploader.userId) ? args.uploader.userId : null;
  const rows: AttachmentInsert[] = [];
  for (const item of fresh) {
    const meta = stored.get(item.path);
    if (meta === undefined || meta === "error") {
      refuse(item, REASON.cantCheck);
    } else if (meta === null) {
      refuse(item, REASON.notUploaded);
    } else if (meta.size <= 0 || meta.size > ATTACHMENT_MAX_BYTES) {
      refuse(item, meta.size <= 0 ? REASON.empty : REASON.tooBig);
      discard.push(item.path);
    } else if (isBlockedContentType(meta.mimetype)) {
      refuse(item, REASON.badType);
      discard.push(item.path);
    } else {
      rows.push({
        ticket_id: args.ticketId,
        reply_id: args.replyId,
        uploaded_by: uploadedBy,
        is_staff: isStaff,
        is_internal: isInternal,
        storage_path: item.path,
        file_name: nameForStoredFile(item.name, item.path),
        content_type: normalizeContentType(meta.mimetype),
        size_bytes: meta.size,
      });
    }
  }

  const recorded: SupportAttachment[] = [];
  if (rows.length > 0) {
    // ignoreDuplicates = ON CONFLICT DO NOTHING: two tabs posting the same
    // staged file at once can't both record it, and the loser isn't an error
    // for the rows that did land.
    const { data, error } = await admin
      .from(TABLE)
      .upsert(rows, { onConflict: "storage_path", ignoreDuplicates: true })
      .select(`${COLUMNS}, storage_path`);
    if (error) {
      console.error("[support-attachments] insert failed", args.ticketId, error.message);
      for (const row of rows) rejected.push({ name: row.file_name, reason: REASON.cantSave });
    } else {
      const saved = new Map(
        ((data ?? []) as AttachmentRow[]).map((r) => [r.storage_path, r]),
      );
      for (const row of rows) {
        const hit = saved.get(row.storage_path);
        if (hit) recorded.push(toAttachment(hit));
        else rejected.push({ name: row.file_name, reason: REASON.already });
      }
    }
  }

  if (discard.length > 0) {
    try {
      const { error } = await admin.storage.from(ATTACHMENT_BUCKET).remove(discard);
      if (error) console.error("[support-attachments] cleanup failed", error.message);
    } catch (err) {
      console.error("[support-attachments] cleanup threw", err);
    }
  }

  return { recorded, rejected };
}

type StoredObject = { size: number; mimetype: string };

/**
 * What storage holds at each path: its metadata, null when there is nothing
 * there, or "error" when the lookup itself failed — which is NOT "the file
 * doesn't exist", and is never treated as grounds to delete anything.
 */
async function readStoredObjects(
  admin: ReturnType<typeof createAdminClient>,
  paths: string[],
): Promise<Map<string, StoredObject | null | "error">> {
  const bucket = admin.storage.from(ATTACHMENT_BUCKET);
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
// Reading
// ---------------------------------------------------------------------------

/**
 * A ticket's attachments, oldest first. Internal files are excluded unless the
 * caller asks for them — the same default, for the same reason, as
 * listTicketReplies: the call site that forgets the flag is then the one that
 * shows too little, not the one that publishes the team's files to the person
 * they're about. Pair with groupAttachmentsByReply to render per message.
 *
 * Errors read as "no attachments" (logged), so a storage-table hiccup costs a
 * thread its file chips rather than the whole page.
 */
export async function listAttachments(
  ticketId: string,
  opts: { includeInternal?: boolean } = {},
): Promise<SupportAttachment[]> {
  if (!isUuid(ticketId)) return [];
  try {
    let query = createAdminClient().from(TABLE).select(COLUMNS).eq("ticket_id", ticketId);
    if (opts.includeInternal !== true) query = query.eq("is_internal", false);
    const { data, error } = await query
      .order("created_at", { ascending: true })
      .limit(LIST_LIMIT);
    if (error) {
      console.error("[support-attachments] list failed", ticketId, error.message);
      return [];
    }
    return ((data ?? []) as AttachmentRow[]).map(toAttachment);
  } catch (err) {
    console.error("[support-attachments] list threw", ticketId, err);
    return [];
  }
}

type DownloadTarget = { attachment: SupportAttachment; storagePath: string };

/**
 * One attachment and the three facts about its ticket that decide who may
 * download it (lib/support-attachment-rules.ts mayDownloadAttachment). This
 * reads with the service role and authorizes NOTHING — the session route
 * applies the rule. Null for a malformed id, a missing row, or any error.
 */
export async function findAttachmentForSession(
  id: string,
): Promise<
  (DownloadTarget & { ticket: { id: string; userId: string | null; sensitive: boolean } }) | null
> {
  if (!isUuid(id)) return null;
  try {
    const admin = createAdminClient();
    const { data: row } = await admin
      .from(TABLE)
      .select(`${COLUMNS}, storage_path`)
      .eq("id", id)
      .maybeSingle();
    if (!row?.storage_path) return null;
    const { data: ticket } = await admin
      .from("support_tickets")
      .select("id, user_id, sensitive")
      .eq("id", row.ticket_id)
      .maybeSingle();
    if (!ticket) return null;
    return {
      attachment: toAttachment(row as AttachmentRow),
      storagePath: row.storage_path,
      ticket: {
        id: ticket.id,
        userId: ticket.user_id ?? null,
        // Fail closed, as with is_internal: only an explicit false is "not confidential".
        sensitive: ticket.sensitive !== false,
      },
    };
  } catch (err) {
    console.error("[support-attachments] session lookup threw", id, err);
    return null;
  }
}

/**
 * One attachment as the holder of a thread token may see it: on THAT ticket,
 * and not internal — filtered in the query and checked again on the row. Null
 * otherwise, with no distinction between a bad token, a missing file and
 * someone else's file.
 */
export async function findAttachmentForToken(
  token: string,
  id: string,
): Promise<DownloadTarget | null> {
  // Shape first, before any database round trip — a malformed URL costs
  // nothing and a probe learns nothing (lib/support-access.ts).
  if (!isTicketToken(token) || !isUuid(id)) return null;
  try {
    const admin = createAdminClient();
    const { data: ticket } = await admin
      .from("support_tickets")
      .select("id")
      .eq("token", token)
      .maybeSingle();
    if (!ticket) return null;
    const { data: row } = await admin
      .from(TABLE)
      .select(`${COLUMNS}, storage_path`)
      .eq("id", id)
      .eq("ticket_id", ticket.id)
      .eq("is_internal", false)
      .maybeSingle();
    if (!row?.storage_path) return null;
    const attachment = toAttachment(row as AttachmentRow);
    if (!tokenMayDownloadAttachment(ticket, attachment)) return null;
    return { attachment, storagePath: row.storage_path };
  } catch (err) {
    console.error("[support-attachments] token lookup threw", err);
    return null;
  }
}

/**
 * A ten-minute URL for one file. CALLERS MUST AUTHORIZE FIRST — the contract
 * lib/webinar-data.ts signedAssetUrl states: this signs whatever it's handed.
 *
 * Images that every browser renders open inline; everything else carries a
 * download name, so the storage server answers `Content-Disposition:
 * attachment` and the reader gets a file under its original name instead of
 * a stranger's PDF or log running in a tab.
 */
export async function signAttachmentUrl(target: DownloadTarget): Promise<string | null> {
  try {
    const { data, error } = await createAdminClient()
      .storage.from(ATTACHMENT_BUCKET)
      .createSignedUrl(target.storagePath, ATTACHMENT_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      console.error("[support-attachments] sign failed", error?.message);
      return null;
    }
    return opensInline(target.attachment)
      ? data.signedUrl
      : withDownloadName(data.signedUrl, target.attachment.fileName);
  } catch (err) {
    console.error("[support-attachments] sign threw", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Responses for the two download routes
// ---------------------------------------------------------------------------

/**
 * Per-viewer and credential-gated: no cache may keep the redirect, and the
 * hop to the storage host must not carry a Referer — on the token route the
 * page that linked here has the token in its path. A `Referrer-Policy` on a
 * redirect response governs the redirected request (Fetch, "HTTP-redirect
 * fetch"), so this one header covers that hop.
 */
const PRIVATE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

export function attachmentRedirect(url: string): NextResponse {
  const res = NextResponse.redirect(url, 302);
  for (const [k, v] of Object.entries(PRIVATE_HEADERS)) res.headers.set(k, v);
  return res;
}

/** The one answer for "no such file" and "not yours" — the same bytes for both. */
export function attachmentNotFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Authorized, but storage wouldn't sign it. Transient by every account of it. */
export function attachmentUnavailable(): Response {
  return new Response("That file couldn't be opened just now. Try again in a moment.", {
    status: 503,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "5",
    },
  });
}
