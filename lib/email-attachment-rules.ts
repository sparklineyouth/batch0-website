/**
 * Outbound email attachments: the limits, the allow-list, the storage path
 * grammar and the shapes, as pure functions over plain data.
 *
 * Why these are not the support-ticket rules
 * ------------------------------------------
 * Both features let someone attach a file, and the file-name hygiene is
 * genuinely shared (lib/file-name-rules.ts). Everything else differs, because
 * the thing on the other end differs. A support attachment lands in a bucket
 * we control and is handed back through a route we authorize. An email
 * attachment leaves the building: it is re-encoded into a MIME part and
 * handed to a mail server that has its own opinions, and the binding limit is
 * not our storage but the recipient's provider.
 *
 * That changes three rules:
 *
 *  - The size cap is set by base64, not by us. SMTP carries attachments
 *    base64-encoded, which costs 4 bytes for every 3 (plus line breaks), so
 *    10 MB of file reaches the wire as about 13.7 MB. Gmail and Outlook both
 *    bounce a message over 25 MB. A 10 MB total therefore fits everywhere
 *    with room for the HTML body; a 20 MB total would pass our checks and
 *    then bounce at the far end, which is the worst possible place to fail.
 *
 *  - The allow-list is narrower AND wider. Wider: an accelerator emails
 *    .docx and .xlsx and .ics, and refusing those would send people back to
 *    their personal mailbox, which is the outcome this whole surface exists
 *    to prevent. Narrower: no HEIC (an iPhone photo a Windows recipient
 *    cannot open is a support ticket, not an attachment), no archives (mail
 *    gateways quarantine them), no legacy or macro-enabled Office formats.
 *
 *  - There is a recipient cap. Nothing stops a 10 MB PDF going to a 2,000
 *    person audience except a rule that says no; that send is gigabytes of
 *    egress, minutes of serverless time, and a spam-folder result for the
 *    whole list. Attachments are for hand-addressed mail and single cohorts.
 *
 * Zero runtime dependencies beyond lib/file-name-rules.ts, which has none of
 * its own: the picker is a client component, and a server-only import here
 * reaches the browser bundle. lib/email-attachment-rules.test.ts pins it.
 *
 * The flow these rules serve is the repo's standard upload flow, the same one
 * support attachments and challenge uploads use:
 *   1. mint   — app/admin/email/compose/attachment-actions.ts checks the
 *               permission, builds the storage path itself, and returns a
 *               one-shot signed upload URL.
 *   2. upload — the browser puts the bytes straight into the private bucket.
 *               A server action body caps at 1 MB; a 10 MB PDF cannot travel
 *               through one, so it never passes through us.
 *   3. send   — lib/email/attachments.ts re-checks every path against the
 *               sender, reads the REAL size and type back out of storage, and
 *               only then encodes anything into a message.
 * What the browser says about a file in steps 1 and 2 is advisory — it buys
 * an honest person an instant, specific error. Step 3 is the enforcement.
 */

import {
  displayFileName,
  fileExtension,
  formatBytes,
  safeFileName,
  UUID_SRC,
} from "./file-name-rules.ts";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The private bucket (migration 0112). Named here rather than only on the
 * server because the browser's uploadToSignedUrl needs it too; the token the
 * server mints is scoped to this bucket and one path, so a mismatch fails at
 * the bucket rather than writing somewhere unexpected.
 */
export const EMAIL_ATTACHMENT_BUCKET = "email-attachments";

/**
 * Per file, and across all files on one email.
 *
 * The total is the number that matters and the one the arithmetic above is
 * about: 10 MB of attachment is ~13.7 MB of base64, which leaves comfortable
 * room under the 25 MB that Gmail, Outlook and most corporate gateways
 * enforce. Resend's own per-request ceiling is 40 MB, so ours binds first and
 * fails early, in our own words, instead of as a provider bounce hours later.
 *
 * Per-file equals the total on purpose: one 10 MB PDF is a normal thing to
 * send, and a second limit that only ever fires in combination would be a
 * rule nobody can predict.
 */
export const EMAIL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const EMAIL_ATTACHMENT_TOTAL_MAX_BYTES = 10 * 1024 * 1024;

/** Five files on one email. Past that it's a shared folder, and the error says so. */
export const EMAIL_ATTACHMENT_MAX_FILES = 5;

/**
 * How many addresses one send may carry attachments to.
 *
 * A cohort is tens of people, and that is the case this is sized for. Beyond
 * it, the same bytes are re-uploaded to the mail provider once per recipient:
 * 10 MB to 2,000 people is 20 GB of egress, far past any serverless time
 * limit, and a near-certain spam classification for a list that size. Those
 * sends want a link to the file, and refuseForRecipientCount says so.
 */
export const EMAIL_ATTACHMENT_MAX_RECIPIENTS = 100;

/** Mirrors `file_name` on the stored JSON — code points, not UTF-16 units. */
export const EMAIL_ATTACHMENT_NAME_MAX = 200;
/** Ours run ~90; the bucket's keys are capped well above this. */
export const EMAIL_ATTACHMENT_PATH_MAX = 512;
export const EMAIL_ATTACHMENT_TYPE_MAX = 200;

/**
 * How long a staged upload is kept before the sweeper reclaims it.
 *
 * An attachment is only needed until its email leaves. Immediate sends are
 * done with it in seconds; a scheduled send needs it until its send time, so
 * the sweeper skips anything an unsent outbox row still points at (see
 * sweepOrphanedAttachments in lib/email/attachments.ts). What is left after a
 * day is a draft someone abandoned.
 */
export const EMAIL_ATTACHMENT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The allow-list, by extension.
 *
 * By extension rather than MIME type, for the reason migration 0087 gave when
 * it dropped MIME allow-lists on mixed uploads: browsers disagree. A `.csv`
 * arrives as text/csv on one machine and application/vnd.ms-excel on another,
 * and a bucket that refuses on MIME surfaces as an opaque 400.
 *
 * Deliberately absent, and each for its own reason:
 *  - svg, html, xml — active content a mail client or browser would execute.
 *  - doc, xls, ppt, docm, xlsm, pptm — legacy and macro-enabled Office. The
 *    OOXML forms below cannot carry a macro; these can, and a macro arriving
 *    from the accelerator's own domain is the most convincing phish there is.
 *  - zip, rar, 7z — corporate gateways quarantine archives unopened, so the
 *    attachment silently never arrives.
 *  - heic, heif — an iPhone photo that most Windows recipients cannot open.
 *    checkEmailAttachmentFile names this one specifically and says convert.
 */
export const EMAIL_ATTACHMENT_EXTENSIONS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "txt",
  "csv",
  "docx",
  "xlsx",
  "pptx",
  "ics",
] as const;

export type EmailAttachmentExtension = (typeof EMAIL_ATTACHMENT_EXTENSIONS)[number];

/** For error messages — the list a person can act on. */
export const EMAIL_ATTACHMENT_TYPES_LABEL =
  "PDF, PNG, JPG, GIF, WebP, TXT, CSV, DOCX, XLSX, PPTX or ICS";

/** For the hint under the picker. */
export const EMAIL_ATTACHMENT_HINT = `${EMAIL_ATTACHMENT_TYPES_LABEL} · up to ${EMAIL_ATTACHMENT_MAX_FILES} files, ${formatBytes(
  EMAIL_ATTACHMENT_TOTAL_MAX_BYTES,
)} in total`;

/**
 * The file input's `accept`: extensions for the desktop picker's filter, plus
 * the matching MIME types, which is what makes iOS offer the photo library
 * alongside Files. Advisory either way — a picker can always be talked out of
 * its filter, which is why checkEmailAttachmentFile runs on every pick.
 */
export const EMAIL_ATTACHMENT_ACCEPT = [
  ...EMAIL_ATTACHMENT_EXTENSIONS.map((e) => `.${e}`),
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
  "text/calendar",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
].join(",");

/**
 * Extension → the Content-Type to put on the MIME part.
 *
 * Derived from the extension rather than echoed from the browser or from
 * storage, because those two disagree and the recipient's mail client acts on
 * whichever we send. A `.docx` that arrives as `application/octet-stream`
 * downloads as an unknown blob on half the clients that receive it; one that
 * arrives with its real type opens in Word. Storage's recorded type is still
 * checked (it is how a tampered upload is caught) — it just isn't what ships.
 */
const CONTENT_TYPE_BY_EXTENSION: Record<EmailAttachmentExtension, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ics: "text/calendar",
};

export function contentTypeForName(name: string): string {
  const ext = fileExtension(name);
  return isAllowedEmailExtension(ext)
    ? CONTENT_TYPE_BY_EXTENSION[ext]
    : "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * One finished upload, as the picker hands it to the compose form. Every
 * field is the browser's claim; resolveAttachments trusts none of them except
 * as a pointer to an object it then inspects itself.
 */
export type StagedEmailAttachment = {
  path: string;
  name: string;
  size: number;
  type: string;
};

/**
 * One attachment ready to hand to a transport. `content` is base64 with no
 * data-URI prefix and no line breaks — the shape both Resend's `attachments`
 * and nodemailer's `{ encoding: "base64" }` take unchanged.
 */
export type OutboundAttachment = {
  filename: string;
  content: string;
  contentType: string;
};

export type RejectedEmailAttachment = { name: string; reason: string };

export type EmailUploadRequestFile = { name: string; size: number; type: string };
export type MintedEmailUpload = { path: string; token: string };
export type EmailMintResult =
  | { ok: true; uploads: MintedEmailUpload[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Checking a file before it uploads
// ---------------------------------------------------------------------------

export function isAllowedEmailExtension(ext: string): ext is EmailAttachmentExtension {
  return (EMAIL_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext);
}

export function isAllowedEmailAttachmentName(name: string): boolean {
  return isAllowedEmailExtension(fileExtension(name));
}

/**
 * Why this one file can't be attached, or null when it can. One function for
 * the picker (instant) and the mint action (authoritative for the URL), so the
 * person sees the same sentence whichever one stops them.
 */
export function checkEmailAttachmentFile(file: { name: string; size: number }): string | null {
  const label = displayFileName(file.name, EMAIL_ATTACHMENT_NAME_MAX);
  const ext = fileExtension(file.name);

  if (!isAllowedEmailExtension(ext)) {
    if (ext === "heic" || ext === "heif") {
      return `${label}: most email clients can't display HEIC. Export it as JPG or PNG and attach that.`;
    }
    if (ext === "zip" || ext === "rar" || ext === "7z") {
      return `${label}: mail servers routinely quarantine archives, so it would never arrive. Attach the files themselves, or link to a folder.`;
    }
    if (ext === "doc" || ext === "xls" || ext === "ppt" || ext.endsWith("m")) {
      return `${label}: we can't send .${ext} files. Save it as .docx, .xlsx or .pptx — or as a PDF — and attach that.`;
    }
    return /^[a-z0-9]{1,10}$/.test(ext)
      ? `${label}: we can't send .${ext} files. Attach a ${EMAIL_ATTACHMENT_TYPES_LABEL} file instead.`
      : `${label}: we can't tell what kind of file this is. Attach a ${EMAIL_ATTACHMENT_TYPES_LABEL} file instead.`;
  }
  if (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size <= 0) {
    return `${label} is empty.`;
  }
  if (file.size > EMAIL_ATTACHMENT_MAX_BYTES) {
    return `${label} is ${formatBytes(file.size)}, over the ${formatBytes(
      EMAIL_ATTACHMENT_MAX_BYTES,
    )} limit — email providers bounce anything bigger. Link to it instead.`;
  }
  return null;
}

/** Total bytes across a set of attachments. */
export function attachmentsTotalBytes(
  items: readonly { size: number }[],
): number {
  return items.reduce(
    (sum, i) => sum + (Number.isFinite(i.size) && i.size > 0 ? i.size : 0),
    0,
  );
}

/**
 * Roughly what these bytes weigh on the wire once base64'd: 4 bytes out per 3
 * in. Shown in the picker beside the raw total, because "9.8 MB of files" and
 * "13.4 MB of email" are different numbers and only the second one bounces.
 */
export function encodedSize(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Why this SET can't go on one email, or null when it can. Separate from the
 * per-file check because the total and the count are properties of the set,
 * and the picker has to re-run them every time one more file is added.
 */
export function checkEmailAttachmentSet(
  items: readonly { name: string; size: number }[],
): string | null {
  if (items.length > EMAIL_ATTACHMENT_MAX_FILES) {
    return `You can attach up to ${EMAIL_ATTACHMENT_MAX_FILES} files to one email. Put the rest in a folder and link to it.`;
  }
  for (const item of items) {
    const problem = checkEmailAttachmentFile(item);
    if (problem) return problem;
  }
  const total = attachmentsTotalBytes(items);
  if (total > EMAIL_ATTACHMENT_TOTAL_MAX_BYTES) {
    return `Those files come to ${formatBytes(total)}, over the ${formatBytes(
      EMAIL_ATTACHMENT_TOTAL_MAX_BYTES,
    )} an email can carry. Remove one, or link to the big one instead.`;
  }
  return null;
}

/**
 * Why this many recipients can't receive attachments, or null when they can.
 * Returned as a sentence rather than a boolean because the only useful version
 * of this refusal is the one that says what to do instead.
 */
export function refuseForRecipientCount(
  recipients: number,
  attachmentCount: number,
): string | null {
  if (attachmentCount <= 0) return null;
  if (recipients <= EMAIL_ATTACHMENT_MAX_RECIPIENTS) return null;
  return `Attachments go to at most ${EMAIL_ATTACHMENT_MAX_RECIPIENTS} addresses at once, and this send has ${recipients}. The same file is uploaded again for every recipient, which is slow, expensive, and a reliable way to land the whole send in spam. Upload it somewhere and put a link in the body instead.`;
}

const FILE_DETAILS_MISSING =
  "That file's details didn't come through. Try attaching it again.";

/**
 * The mint action's input check: a list of 1–5 files the picker would also
 * have accepted, within the total. All-or-nothing — the picker sends one batch
 * per pick and shows one error for it.
 */
export function validateEmailUploadRequest(
  raw: unknown,
  alreadyAttachedBytes = 0,
): { ok: true; files: EmailUploadRequestFile[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "Choose a file to attach." };
  }
  if (raw.length > EMAIL_ATTACHMENT_MAX_FILES) {
    return {
      ok: false,
      error: `You can attach up to ${EMAIL_ATTACHMENT_MAX_FILES} files to one email.`,
    };
  }
  const files: EmailUploadRequestFile[] = [];
  for (const entry of raw) {
    const f = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    if (
      !f ||
      typeof f.name !== "string" ||
      !f.name.trim() ||
      f.name.length > 1000 ||
      typeof f.size !== "number" ||
      (f.type !== undefined && typeof f.type !== "string")
    ) {
      return { ok: false, error: FILE_DETAILS_MISSING };
    }
    const problem = checkEmailAttachmentFile({ name: f.name, size: f.size });
    if (problem) return { ok: false, error: problem };
    files.push({
      name: f.name,
      size: f.size,
      type: typeof f.type === "string" ? f.type.slice(0, EMAIL_ATTACHMENT_TYPE_MAX) : "",
    });
  }

  // The batch being minted plus whatever is already on the draft. Without
  // this, five separate one-file picks sail past a total the picker only ever
  // checked one batch at a time.
  const total = attachmentsTotalBytes(files) + Math.max(0, alreadyAttachedBytes);
  if (total > EMAIL_ATTACHMENT_TOTAL_MAX_BYTES) {
    return {
      ok: false,
      error: `That would put this email at ${formatBytes(total)} of attachments, over the ${formatBytes(
        EMAIL_ATTACHMENT_TOTAL_MAX_BYTES,
      )} limit.`,
    };
  }
  return { ok: true, files };
}

// ---------------------------------------------------------------------------
// The path grammar
// ---------------------------------------------------------------------------

/**
 * Every object in the bucket lives at exactly one shape:
 *
 *   c/<sender's user id>/<object uuid>-<safe name>
 *
 * One folder per sender, because unlike a ticket an email has no id before it
 * is sent — there is nothing else to key on, and the sender is the only
 * principal involved. The server builds every path; the browser only ever
 * echoes one back. Checking the WHOLE shape, not just the prefix, is what
 * makes the prefix check mean something: `c/<mine>/../c/<yours>/x.pdf` starts
 * with the right prefix and is still refused, because a name segment cannot
 * hold a slash or a `..`.
 */
const PATH_RE = new RegExp(`^c/${UUID_SRC}/${UUID_SRC}-[a-z0-9][a-z0-9._-]{0,99}$`);

export function emailAttachmentPrefix(userId: string): string {
  return `c/${userId.toLowerCase()}/`;
}

/** `objectId` is a fresh random uuid — unguessable, so a path names one upload. */
export function buildEmailAttachmentPath(
  prefix: string,
  objectId: string,
  fileName: string,
): string {
  return `${prefix}${objectId.toLowerCase()}-${safeFileName(fileName)}`;
}

export function isWellFormedEmailAttachmentPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= EMAIL_ATTACHMENT_PATH_MAX &&
    PATH_RE.test(path)
  );
}

/**
 * May this sender send this path? Their own folder only.
 *
 * Deliberately not "any admin's folder": two admins with email.send are two
 * principals, and a draft that references a path is a thing a tampered request
 * can carry. There is no case where composing an email needs to reach into
 * another person's staged uploads.
 */
export function isOwnEmailAttachmentPath(path: unknown, userId: string): boolean {
  return (
    isWellFormedEmailAttachmentPath(path) && path.startsWith(emailAttachmentPrefix(userId))
  );
}

// ---------------------------------------------------------------------------
// Reading what the form posted
// ---------------------------------------------------------------------------

/** Five entries of a few hundred characters each. Anything near this is not from the picker. */
const STAGED_JSON_MAX = 16 * 1024;

const LIST_MALFORMED: RejectedEmailAttachment = {
  name: "Attachments",
  reason: "The list of attached files didn't come through. Attach them again.",
};

/**
 * The draft's attachment list, read defensively: a string (straight off
 * FormData or the outbox's jsonb) or an already-parsed array; at most `max`
 * entries; each one `{path, name, size, type}` with the right primitive types.
 * Bad entries are rejected one by one rather than sinking the batch, and an
 * empty or missing value is simply "no attachments".
 *
 * This only checks the SHAPE. Whether the path is the sender's to use, and
 * whether the object behind it is what it claims, is resolveAttachments's job.
 */
export function parseStagedEmailAttachments(
  raw: unknown,
  max: number = EMAIL_ATTACHMENT_MAX_FILES,
): { items: StagedEmailAttachment[]; rejected: RejectedEmailAttachment[] } {
  if (raw === null || raw === undefined || raw === "") return { items: [], rejected: [] };
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > STAGED_JSON_MAX) return { items: [], rejected: [LIST_MALFORMED] };
    try {
      value = JSON.parse(raw);
    } catch {
      return { items: [], rejected: [LIST_MALFORMED] };
    }
  }
  if (!Array.isArray(value)) return { items: [], rejected: [LIST_MALFORMED] };

  const items: StagedEmailAttachment[] = [];
  const rejected: RejectedEmailAttachment[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const name =
      typeof e?.name === "string"
        ? displayFileName(e.name, EMAIL_ATTACHMENT_NAME_MAX)
        : "file";
    if (
      !e ||
      typeof e.path !== "string" ||
      !e.path ||
      e.path.length > EMAIL_ATTACHMENT_PATH_MAX ||
      typeof e.name !== "string" ||
      typeof e.size !== "number" ||
      !Number.isFinite(e.size) ||
      (e.type !== undefined && typeof e.type !== "string")
    ) {
      rejected.push({ name, reason: FILE_DETAILS_MISSING });
      continue;
    }
    // The same upload listed twice is one attachment, not an error.
    if (seen.has(e.path)) continue;
    if (items.length >= max) {
      rejected.push({ name, reason: `Only ${max} files can go on one email.` });
      continue;
    }
    seen.add(e.path);
    items.push({
      path: e.path,
      name: e.name.slice(0, 1000),
      size: e.size,
      type: typeof e.type === "string" ? e.type.slice(0, EMAIL_ATTACHMENT_TYPE_MAX) : "",
    });
  }
  return { items, rejected };
}

/**
 * The name the recipient sees on the attachment.
 *
 * The browser's name is used only when its extension matches the path's — and
 * the path's was checked against the allow-list when it was minted. That stops
 * a tampered draft delivering a PDF upload under the name `invoice.exe`, which
 * is what the recipient's mail client would then offer to save.
 */
export function nameForOutboundFile(clientName: unknown, path: string): string {
  const pathExt = fileExtension(path);
  if (typeof clientName === "string") {
    const display = displayFileName(clientName, EMAIL_ATTACHMENT_NAME_MAX);
    if (pathExt && fileExtension(display) === pathExt) return display;
  }
  const segment = path.slice(path.lastIndexOf("/") + 1).replace(
    new RegExp(`^${UUID_SRC}-`),
    "",
  );
  return segment || (pathExt ? `file.${pathExt}` : "file");
}

/** A one-line summary for the audit payload and the send confirmation. */
export function describeAttachments(
  items: readonly { name: string; size: number }[],
): string {
  if (items.length === 0) return "";
  const total = formatBytes(attachmentsTotalBytes(items));
  return items.length === 1
    ? `${displayFileName(items[0].name, EMAIL_ATTACHMENT_NAME_MAX)} (${total})`
    : `${items.length} files (${total})`;
}
