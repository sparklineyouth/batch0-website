"use server";

import { createHash, randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { checkRateLimit } from "@/lib/rate-limit";
import { isTicketToken, normalizeReference } from "@/lib/support-access";
import {
  ATTACHMENT_BUCKET,
  buildAttachmentPath,
  parseAttachmentScope,
  requesterMayAttach,
  staffMayAttach,
  stagingPrefix,
  ticketPrefix,
  validateUploadRequest,
  type AttachmentScope,
  type MintResult,
  type MintedUpload,
  type UploadRequestFile,
} from "@/lib/support-attachment-rules";

/**
 * Step 1 of a ticket attachment: decide who is asking, build the storage path
 * ourselves, and hand back a one-shot signed upload URL for it. The bytes then
 * go straight from the browser to the private bucket — a server action body
 * caps at 1 MB, and a 10 MB screen recording can't travel through one.
 *
 * The path is the whole of the authorization the URL carries, so it is never
 * the browser's choice: `u/<the caller's uid>/…` for a request that doesn't
 * exist yet, `t/<a ticket the caller proved access to>/…` for everything else,
 * with a fresh random uuid in front of a sanitized name. A signed upload URL
 * can't carry a size or type limit, so the checks here run on what the browser
 * SAYS about each file — honest people get an instant, specific error. The
 * enforcement is recordAttachments (lib/support-attachments.ts), which looks
 * at what actually landed before any message may reference it.
 *
 * Returns `{ ok, uploads | error }` rather than throwing, for the reason
 * lib/action-result.ts gives: a thrown message is stripped in production, and
 * "this request is closed" is worth showing.
 */

const NOT_FOUND = "We couldn't find that request.";
const CLOSED =
  "This request is closed, so it can't take new files. Open a new request if you still need help.";
const SIGNED_OUT = "Sign in to attach files.";
const FORBIDDEN = "You don't have permission to add files to this request.";
const TOO_MANY = "That's a lot of uploads at once. Give it a few minutes.";
const FAILED = "We couldn't start the upload. Try again in a moment.";

/** Ten minutes, the window every limit below counts in. */
const WINDOW_SECONDS = 600;

/**
 * Per-call limits — a call carries up to five files. A requester attaching to
 * one message makes one call per pick, so twenty is several messages' worth of
 * picking and re-picking; past that, it's someone filling the bucket. Staff
 * answer many tickets in a sitting, so theirs is looser. All fail open (see
 * lib/rate-limit), which is acceptable because every kind of caller here has
 * already proved an account, a ticket token, or a staff permission.
 */
const LIMITS = {
  user: 20,
  staff: 60,
  token: 20,
  ip: 40,
} as const;

/**
 * A rate-limit key for a ticket token that isn't the token — the same
 * derivation as app/support/actions.ts, for its reason: checkRateLimit stores
 * its key in the clear, and the secret that authorizes a thread must not sit
 * in a table row keyed for lookup.
 */
function tokenRateKey(token: string): string {
  return createHash("sha256")
    .update("batch0:support-rl:v1:")
    .update(token)
    .digest("hex")
    .slice(0, 32);
}

async function withinLimit(kind: string, identifier: string, limit: number): Promise<boolean> {
  const res = await checkRateLimit({ kind, identifier, limit, windowSeconds: WINDOW_SECONDS });
  return res.ok;
}

/** The verified session user, or null — requireActor throws when signed out. */
async function sessionUserId(): Promise<string | null> {
  try {
    return (await requireActor()).userId;
  } catch {
    return null;
  }
}

type Target = { ok: true; prefix: string } | { ok: false; error: string };

/**
 * Which folder this caller may upload into, after proving they may.
 *
 * The order inside each branch is deliberate: the cheap shape check, then the
 * rate limit, then the database. A limit that ran after the lookup would let
 * a script turn this action into a free ticket-existence probe.
 */
async function resolveTarget(scope: AttachmentScope): Promise<Target> {
  const admin = createAdminClient();

  switch (scope.kind) {
    case "new": {
      // A request that doesn't exist yet: the caller's own staging folder.
      // recordAttachments later accepts files from here only for this same
      // user, filing through their session.
      const userId = await sessionUserId();
      if (!userId) return { ok: false, error: SIGNED_OUT };
      if (!(await withinLimit("support-upload:user", userId, LIMITS.user))) {
        return { ok: false, error: TOO_MANY };
      }
      return { ok: true, prefix: stagingPrefix(userId) };
    }

    case "own": {
      const userId = await sessionUserId();
      if (!userId) return { ok: false, error: SIGNED_OUT };
      const reference = normalizeReference(scope.reference);
      if (!reference) return { ok: false, error: NOT_FOUND };
      if (!(await withinLimit("support-upload:user", userId, LIMITS.user))) {
        return { ok: false, error: TOO_MANY };
      }
      // Filtered on the owner in the query AND checked again below: "not
      // yours" and "doesn't exist" are the same answer, by construction.
      const { data, error } = await admin
        .from("support_tickets")
        .select("id, user_id, status")
        .eq("reference", reference)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) console.error("[support-attachments] own lookup failed", error.message);
      if (!data) return { ok: false, error: NOT_FOUND };
      if (!requesterMayAttach(userId, { userId: data.user_id, status: data.status })) {
        return { ok: false, error: data.user_id === userId ? CLOSED : NOT_FOUND };
      }
      return { ok: true, prefix: ticketPrefix(data.id) };
    }

    case "token": {
      // The same answer for a malformed token and a wrong one; a distinct
      // error would tell a prober their guess had the right shape.
      if (!isTicketToken(scope.token)) return { ok: false, error: NOT_FOUND };
      const ip =
        (await headers()).get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
      const [byToken, byIp] = await Promise.all([
        withinLimit("support-upload:token", tokenRateKey(scope.token), LIMITS.token),
        withinLimit("support-upload:ip", ip, LIMITS.ip),
      ]);
      if (!byToken || !byIp) return { ok: false, error: TOO_MANY };
      const { data, error } = await admin
        .from("support_tickets")
        .select("id, status")
        .eq("token", scope.token)
        .maybeSingle();
      if (error) console.error("[support-attachments] token lookup failed", error.message);
      if (!data) return { ok: false, error: NOT_FOUND };
      if (data.status === "closed") return { ok: false, error: CLOSED };
      return { ok: true, prefix: ticketPrefix(data.id) };
    }

    case "staff": {
      let actor: Awaited<ReturnType<typeof assertPermission>>;
      try {
        actor = await assertPermission("support.manage");
      } catch {
        return { ok: false, error: FORBIDDEN };
      }
      if (!(await withinLimit("support-upload:staff", actor.userId, LIMITS.staff))) {
        return { ok: false, error: TOO_MANY };
      }
      const { data, error } = await admin
        .from("support_tickets")
        .select("id, sensitive")
        .eq("id", scope.ticketId)
        .maybeSingle();
      if (error) console.error("[support-attachments] staff lookup failed", error.message);
      if (!data) return { ok: false, error: NOT_FOUND };
      // A confidential concern stays invisible to staff without
      // support.sensitive — so they get the not-found answer, not a
      // permission error that would confirm the ticket exists.
      const allowed = staffMayAttach(
        {
          canManage: true,
          canSeeSensitive: can(actor.caps, "support.sensitive"),
        },
        // Fail closed: only an explicit false is "not confidential".
        { sensitive: data.sensitive !== false },
      );
      if (!allowed) return { ok: false, error: NOT_FOUND };
      return { ok: true, prefix: ticketPrefix(data.id) };
    }
  }
}

/**
 * Signed upload URLs for up to five files, in the order given.
 *
 * `scope` and `files` arrive from the browser, so both are re-validated here
 * whatever their declared types say. All-or-nothing: if any URL can't be
 * minted, none is returned, and the picker shows one error for the pick.
 */
export async function mintSupportUploads(
  scope: AttachmentScope,
  files: UploadRequestFile[],
): Promise<MintResult> {
  try {
    const request = validateUploadRequest(files);
    if (!request.ok) return request;
    const parsed = parseAttachmentScope(scope);
    if (!parsed) return { ok: false, error: NOT_FOUND };

    const target = await resolveTarget(parsed);
    if (!target.ok) return target;

    const bucket = createAdminClient().storage.from(ATTACHMENT_BUCKET);
    const minted = await Promise.all(
      request.files.map(async (file): Promise<MintedUpload | null> => {
        const path = buildAttachmentPath(target.prefix, randomUUID(), file.name);
        const { data, error } = await bucket.createSignedUploadUrl(path);
        if (error || !data?.token) {
          console.error("[support-attachments] mint failed", error?.message);
          return null;
        }
        return { path, token: data.token };
      }),
    );
    if (minted.some((m) => m === null)) return { ok: false, error: FAILED };
    return { ok: true, uploads: minted as MintedUpload[] };
  } catch (err) {
    console.error("[support-attachments] mint threw", err);
    return { ok: false, error: FAILED };
  }
}
