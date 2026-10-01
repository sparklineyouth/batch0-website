/**
 * Support-ticket attachments: the limits, the file-name rules, the storage
 * path grammar and the who-may-touch-what predicates, as pure functions over
 * plain data.
 *
 * Why this file has zero imports
 * ------------------------------
 * The same reason as lib/support-access.ts. These rules are needed by four
 * things that cannot share a Supabase client: the server action that mints an
 * upload URL, the server code that records the finished file, the routes that
 * hand a file back out, and the `"use client"` picker that has to refuse a
 * 40 MB video before it costs anyone a round trip. Keeping this module
 * dependency-free is what lets the browser bundle import the limits without
 * dragging a database driver in. lib/support-attachment-rules.test.ts pins it.
 *
 * The flow these rules serve is the one every upload in this repo uses (see
 * getChallengeUploadToken / verifyNewUploads in app/challenges/[slug]/actions.ts):
 *   1. mint   — app/support/attachment-actions.ts decides who is asking, builds
 *               the storage path itself, and returns a one-shot signed upload URL.
 *   2. upload — the browser puts the bytes straight into the private bucket. A
 *               server action body caps at 1 MB, so the bytes never pass through us.
 *   3. record — lib/support-attachments.ts re-checks every path against the
 *               uploader, reads the REAL size and type back out of storage, and
 *               only then writes a row.
 *   4. read   — app/support/files/[id] and app/support/t/[token]/files/[id]
 *               re-authorize on every click and redirect to a 10-minute URL.
 * Everything the browser says about a file in steps 1 and 2 is advisory — it
 * buys an honest person an instant, specific error. Step 3 is the enforcement.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The private bucket (migration 0090). Named here rather than only on the
 * server because the browser's uploadToSignedUrl needs it too; the token the
 * server mints is scoped to this bucket and one path, so a mismatch fails at
 * the bucket rather than writing somewhere unexpected.
 */
export const ATTACHMENT_BUCKET = "support-attachments";

/**
 * 10 MB a file, five files a message. Mirrors `size_bytes between 1 and
 * 10485760` on support_ticket_attachments and the bucket's own
 * file_size_limit — the bucket is the hard stop, because a signed upload URL
 * cannot carry a size limit of its own.
 *
 * Ten is enough for any screenshot, photo, receipt PDF or log file, and for a
 * short screen recording. A longer recording belongs in a link, and the
 * "too big" message says so rather than leaving the person stuck.
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 5;

/** `file_name` is `char_length between 1 and 200` — code points, not UTF-16 units. */
export const ATTACHMENT_NAME_MAX = 200;
/** `storage_path` is `char_length between 1 and 512`. Ours are ~180 at most. */
export const ATTACHMENT_PATH_MAX = 512;
/** `content_type` is `char_length <= 200`. */
export const ATTACHMENT_TYPE_MAX = 200;

/**
 * How long a download URL lives. Ten minutes, the repo's house TTL for
 * per-click signed reads (lib/webinar-data.ts signedAssetUrl): the URL is
 * minted at the moment of the click, so it only has to outlive the start of
 * the download, and one pasted into a group chat is dead before it's useful.
 */
export const ATTACHMENT_URL_TTL_SECONDS = 60 * 10;

/**
 * The allow-list, by extension. Screenshots and photos (HEIC/HEIF is what an
 * iPhone camera produces), receipts as PDF, logs and exports as text, and
 * short screen recordings.
 *
 * By extension rather than MIME type, for the reason migration 0087 dropped
 * MIME allow-lists on mixed uploads: browsers disagree. A `.csv` arrives as
 * text/csv on one machine and application/vnd.ms-excel on another, a `.log`
 * often arrives with no type at all, and a bucket that refuses on MIME
 * surfaces as an opaque 400. The type that storage records is still checked
 * (isBlockedContentType) — it just isn't the gate.
 *
 * Deliberately absent: SVG and HTML (active content a browser would execute),
 * office documents (macros), archives (unscannable), executables.
 */
export const ATTACHMENT_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "heic",
  "heif",
  "pdf",
  "txt",
  "log",
  "csv",
  "mp4",
  "mov",
  "webm",
] as const;

export type AttachmentExtension = (typeof ATTACHMENT_EXTENSIONS)[number];

/** For error messages — the list a person can act on. */
export const ATTACHMENT_TYPES_LABEL =
  "PNG, JPG, GIF, WebP, HEIC, PDF, TXT, LOG, CSV, MP4, MOV or WebM";

/** For the hint under the picker. */
export const ATTACHMENT_HINT = `Screenshots, photos, PDFs, text files or short videos · up to ${ATTACHMENT_MAX_FILES} files, ${formatBytes(ATTACHMENT_MAX_BYTES)} each`;

/**
 * The file input's `accept`. Extensions for the desktop picker's filter, plus
 * the matching MIME types, which is what makes iOS offer the photo library
 * alongside Files. Advisory either way — a picker can always be talked out of
 * its filter, which is why checkAttachmentFile runs on every pick.
 */
export const ATTACHMENT_ACCEPT = [
  ...ATTACHMENT_EXTENSIONS.map((e) => `.${e}`),
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "video/mp4",
  "video/quicktime",
  "video/webm",
].join(",");

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * One finished upload, as the picker hands it to a form: the hidden input's
 * value is `JSON.stringify(StagedAttachment[])`. Every field is the browser's
 * claim. recordAttachments trusts none of them except as a pointer to an
 * object it then inspects itself.
 */
export type StagedAttachment = {
  path: string;
  name: string;
  size: number;
  type: string;
};

/** A recorded attachment, as every surface renders it. No storage path on it. */
export type SupportAttachment = {
  id: string;
  ticketId: string;
  /** null = filed with the original request. */
  replyId: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  isStaff: boolean;
  isInternal: boolean;
  createdAt: string;
};

export type RejectedAttachment = { name: string; reason: string };

/**
 * Who is asking for an upload URL. Each kind proves itself differently, and
 * each gets its own folder (see the path grammar below):
 *  - `new`   — a signed-in person writing a request that doesn't exist yet;
 *  - `own`   — a signed-in person on their own ticket, by reference;
 *  - `token` — whoever holds an emailed thread link;
 *  - `staff` — support.manage, plus support.sensitive on a confidential ticket.
 */
export type AttachmentScope =
  | { kind: "new" }
  | { kind: "own"; reference: string }
  | { kind: "token"; token: string }
  | { kind: "staff"; ticketId: string };

/**
 * Who is recording a staged upload onto a ticket. Server-derived by the action
 * that calls recordAttachments — never read off the request.
 */
export type AttachmentUploader =
  | { kind: "requester"; userId: string | null; via: "session" | "token" }
  | { kind: "staff"; userId: string };

/** How the page rendering a file link was authorized, which picks the route. */
export type AttachmentAccess = { kind: "session" } | { kind: "token"; token: string };

export type UploadRequestFile = { name: string; size: number; type: string };
export type MintedUpload = { path: string; token: string };
export type MintResult =
  | { ok: true; uploads: MintedUpload[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

/** The last path segment, for either separator. A file name is never a path. */
function baseName(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * The final extension, lowercased, or "" when there isn't one.
 *
 * Only the LAST extension counts, because it's the one an operating system
 * acts on: `invoice.png.exe` is an `exe`. A leading dot alone (`.png`) is a
 * hidden file with no extension, and a trailing dot (`x.png.`) has none either.
 */
export function fileExtension(name: string): string {
  const base = baseName(String(name ?? "")).trim();
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isAllowedExtension(ext: string): ext is AttachmentExtension {
  return (ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext);
}

export function isAllowedAttachmentName(name: string): boolean {
  return isAllowedExtension(fileExtension(name));
}

/** Latin diacritics off ("résumé" → "resume"); NFKD also unfolds ligatures and full-width forms. */
function asciiFold(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * A file name safe to use as the last segment of a storage key.
 *
 * Storage keys are a narrower alphabet than file names (Supabase refuses many
 * non-ASCII keys outright), and this name sits inside a path the server builds
 * — so it is reduced to `[a-z0-9_-]` plus the one dot before the extension:
 * no path separators, no leading dot, no `..`, at most ~90 characters. With a
 * single dot, the stored object's extension is always the extension that was
 * checked, never a fragment of the stem ("report.v2.pdf" → "report-v2.pdf").
 * It is never shown to anyone: the name a person sees and downloads as is
 * displayFileName's, kept on the row.
 */
export function safeFileName(name: string): string {
  const base = baseName(String(name ?? "")).trim();
  const rawExt = fileExtension(base);
  const ext = rawExt.replace(/[^a-z0-9]/g, "").slice(0, 10);
  const stem = rawExt ? base.slice(0, base.lastIndexOf(".")) : base;
  const clean = asciiFold(stem)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 80)
    .replace(/[-_]+$/, "");
  const out = clean || "file";
  return ext ? `${out}.${ext}` : out;
}

/**
 * Characters that change how a name is DISPLAYED without being part of it:
 * C0/C1 controls, zero-width space, BOM, and the bidi overrides. The last are
 * the dangerous ones — `photo\u202Efdp.exe` renders as "photoexe.pdf".
 * (The allow-list would refuse that `exe` anyway; this keeps the label honest.)
 */
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * The name a person sees on the chip and gets when they download the file.
 * Unicode is kept — "Снимок экрана.png" is a perfectly good name — but path
 * separators, invisible characters and runs of whitespace are not, and it is
 * cut to the column's 200 code points with the extension kept on the end.
 */
export function displayFileName(name: string): string {
  const cleaned = baseName(String(name ?? ""))
    // Whitespace first: a tab or newline in a name separates words, so it
    // becomes a space rather than vanishing with the other control characters.
    .replace(/\s+/g, " ")
    .replace(INVISIBLE_RE, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!cleaned) return "file";
  const chars = Array.from(cleaned);
  if (chars.length <= ATTACHMENT_NAME_MAX) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const tail = dot > 0 && cleaned.length - dot <= 11 ? cleaned.slice(dot) : "";
  const room = ATTACHMENT_NAME_MAX - Array.from(tail).length - 1;
  const head = Array.from(cleaned.slice(0, dot > 0 && tail ? dot : cleaned.length))
    .slice(0, room)
    .join("")
    .trimEnd();
  return `${head}…${tail}`;
}

const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OBJECT_PREFIX_RE = new RegExp(`^${UUID_SRC}-`);

/**
 * The name to store for an upload, given what the browser called it and the
 * path the server built for it.
 *
 * The browser's name is used only when its extension matches the path's —
 * and the path's was checked against the allow-list when it was minted. That
 * stops a tampered client recording a PNG upload under the name `setup.exe`,
 * which is what a teammate's browser would then save it as. Anything else
 * falls back to the server-built name.
 */
export function nameForStoredFile(clientName: unknown, path: string): string {
  const pathExt = fileExtension(path);
  if (typeof clientName === "string") {
    const display = displayFileName(clientName);
    if (pathExt && fileExtension(display) === pathExt) return display;
  }
  const segment = path.slice(path.lastIndexOf("/") + 1).replace(OBJECT_PREFIX_RE, "");
  return segment || (pathExt ? `file.${pathExt}` : "file");
}

// ---------------------------------------------------------------------------
// Checking a file before it uploads
// ---------------------------------------------------------------------------

function isVideoExtension(ext: string): boolean {
  return ext === "mp4" || ext === "mov" || ext === "webm";
}

/**
 * Why this file can't be attached, or null when it can. One function for the
 * picker (instant) and the mint action (authoritative for the URL), so the
 * person sees the same sentence whichever one stops them.
 */
export function checkAttachmentFile(file: { name: string; size: number }): string | null {
  const label = displayFileName(file.name);
  const ext = fileExtension(file.name);
  if (!isAllowedExtension(ext)) {
    return /^[a-z0-9]{1,10}$/.test(ext)
      ? `${label}: we can't take .${ext} files. Attach a ${ATTACHMENT_TYPES_LABEL} file instead.`
      : `${label}: we can't tell what kind of file this is. Attach a ${ATTACHMENT_TYPES_LABEL} file instead.`;
  }
  if (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size <= 0) {
    return `${label} is empty.`;
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return `${label} is over the ${formatBytes(ATTACHMENT_MAX_BYTES)} limit${
      isVideoExtension(ext)
        ? " — for a longer recording, put a link to it in your message instead"
        : ""
    }.`;
  }
  return null;
}

const FILE_DETAILS_MISSING =
  "That file's details didn't come through. Try attaching it again.";

/**
 * The mint action's input check: a list of 1–5 files, each one the picker
 * would also have accepted. All-or-nothing — the picker sends one batch per
 * pick and shows one error for it.
 */
export function validateUploadRequest(
  raw: unknown,
): { ok: true; files: UploadRequestFile[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "Choose a file to attach." };
  }
  if (raw.length > ATTACHMENT_MAX_FILES) {
    return {
      ok: false,
      error: `You can attach up to ${ATTACHMENT_MAX_FILES} files to one message.`,
    };
  }
  const files: UploadRequestFile[] = [];
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
    const problem = checkAttachmentFile({ name: f.name, size: f.size });
    if (problem) return { ok: false, error: problem };
    files.push({
      name: f.name,
      size: f.size,
      type: typeof f.type === "string" ? f.type.slice(0, ATTACHMENT_TYPE_MAX) : "",
    });
  }
  return { ok: true, files };
}

/** Narrows an untrusted scope (it arrives as a server-action argument). */
export function parseAttachmentScope(raw: unknown): AttachmentScope | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  switch (s.kind) {
    case "new":
      return { kind: "new" };
    case "own":
      return typeof s.reference === "string" && s.reference.length <= 40
        ? { kind: "own", reference: s.reference }
        : null;
    case "token":
      return typeof s.token === "string" && s.token.length <= 64
        ? { kind: "token", token: s.token }
        : null;
    case "staff":
      return isUuid(s.ticketId) ? { kind: "staff", ticketId: s.ticketId } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The path grammar
// ---------------------------------------------------------------------------

const UUID_RE = new RegExp(`^${UUID_SRC}$`, "i");

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Every object in the bucket lives at exactly one of two shapes:
 *
 *   u/<user id>/<object uuid>-<safe name>    staged by a signed-in requester
 *                                            before their ticket exists
 *   t/<ticket id>/<object uuid>-<safe name>  everything else: follow-ups,
 *                                            token holders, staff
 *
 * The server builds every path (buildAttachmentPath); the browser only ever
 * echoes one back. Checking the WHOLE shape, not just a prefix, is what makes
 * the prefix check mean something: `t/<mine>/../u/<yours>/x.png` starts with
 * the right prefix and is still refused, because a name segment can't hold a
 * slash or a `..`.
 */
const PATH_RE = new RegExp(`^(u|t)/${UUID_SRC}/${UUID_SRC}-[a-z0-9][a-z0-9._-]{0,99}$`);

export function stagingPrefix(userId: string): string {
  return `u/${userId.toLowerCase()}/`;
}

export function ticketPrefix(ticketId: string): string {
  return `t/${ticketId.toLowerCase()}/`;
}

/** `objectId` is a fresh random uuid — unguessable, so a path names one upload. */
export function buildAttachmentPath(prefix: string, objectId: string, fileName: string): string {
  return `${prefix}${objectId.toLowerCase()}-${safeFileName(fileName)}`;
}

export function isWellFormedAttachmentPath(path: unknown): path is string {
  return typeof path === "string" && path.length <= ATTACHMENT_PATH_MAX && PATH_RE.test(path);
}

export function isPathUnderPrefix(path: unknown, prefixes: readonly string[]): boolean {
  return isWellFormedAttachmentPath(path) && prefixes.some((p) => path.startsWith(p));
}

/**
 * The folders an uploader may record from, onto one ticket.
 *
 * A signed-in requester: their own staging folder and that ticket's folder. A
 * token holder: the ticket's folder only — the link proves nothing about any
 * account, so it can't vouch for anything staged under one. Staff: the
 * ticket's folder only, which is where the staff mint puts their files.
 */
export function allowedPrefixesFor(uploader: AttachmentUploader, ticketId: string): string[] {
  if (!isUuid(ticketId)) return [];
  const own = ticketPrefix(ticketId);
  if (
    uploader.kind === "requester" &&
    uploader.via === "session" &&
    isUuid(uploader.userId)
  ) {
    return [stagingPrefix(uploader.userId), own];
  }
  return [own];
}

// ---------------------------------------------------------------------------
// Reading what a form posted
// ---------------------------------------------------------------------------

/** Five entries of a few hundred characters each. Anything near this is not from the picker. */
const STAGED_JSON_MAX = 16 * 1024;

const LIST_MALFORMED: RejectedAttachment = {
  name: "Attachments",
  reason: "The list of attached files didn't come through. Attach them again.",
};

/**
 * The hidden input's JSON, read defensively: a string (straight off FormData)
 * or an already-parsed array; at most `max` entries; each one
 * `{path, name, size, type}` with the right primitive types. Bad entries are
 * rejected one by one rather than sinking the batch, and an empty or missing
 * value is simply "no attachments".
 *
 * This only checks the SHAPE. Whether the path is the poster's to record, and
 * whether the object behind it is what it claims, is recordAttachments's job.
 */
export function parseStagedAttachments(
  raw: unknown,
  max: number = ATTACHMENT_MAX_FILES,
): { items: StagedAttachment[]; rejected: RejectedAttachment[] } {
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

  const items: StagedAttachment[] = [];
  const rejected: RejectedAttachment[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const name = typeof e?.name === "string" ? displayFileName(e.name) : "file";
    if (
      !e ||
      typeof e.path !== "string" ||
      !e.path ||
      e.path.length > ATTACHMENT_PATH_MAX ||
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
      rejected.push({ name, reason: `Only ${max} files can go on one message.` });
      continue;
    }
    seen.add(e.path);
    items.push({
      path: e.path,
      name: e.name.slice(0, 1000),
      size: e.size,
      type: typeof e.type === "string" ? e.type.slice(0, ATTACHMENT_TYPE_MAX) : "",
    });
  }
  return { items, rejected };
}

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

/**
 * Active content a browser would execute if someone opened the file directly.
 * The challenge-upload list (app/challenges/[slug]/actions.ts BLOCKED_MIME)
 * plus XML, which can carry an XHTML namespace and script. None of these can
 * come from an allowed extension honestly, so a match means a tampered upload.
 */
const BLOCKED_TYPE_RE =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/(x-)?javascript|text\/javascript|application\/xml|text\/xml)/i;

export function isBlockedContentType(type: string | null | undefined): boolean {
  return BLOCKED_TYPE_RE.test(String(type ?? "").trim());
}

/** What goes in `content_type`: storage's word for it, tidied, never empty. */
export function normalizeContentType(type: string | null | undefined): string {
  const t = String(type ?? "").trim().toLowerCase().slice(0, ATTACHMENT_TYPE_MAX);
  return t || "application/octet-stream";
}

/** Raster formats every browser renders. HEIC is an image but not one Chrome can show. */
const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
const INLINE_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

export function isImageType(type: string | null | undefined): boolean {
  const base = String(type ?? "").split(";")[0].trim().toLowerCase();
  return INLINE_IMAGE_TYPES.includes(base);
}

/**
 * Should this file open in the browser rather than download? Only when BOTH
 * the stored type and the name say it's a browser-renderable image. Everything
 * else downloads under its own name: a PDF, a log or a video opened inline is
 * a document from a stranger running in a viewer, and a download is a file
 * the reader chose to open.
 */
export function opensInline(file: { contentType: string; fileName: string }): boolean {
  return (
    isImageType(file.contentType) &&
    INLINE_IMAGE_EXTENSIONS.includes(fileExtension(file.fileName))
  );
}

export type AttachmentKind = "image" | "video" | "pdf" | "text" | "file";

/** Which icon a chip gets. Cosmetic only — nothing authorizes off this. */
export function attachmentKind(file: { contentType?: string | null; fileName: string }): AttachmentKind {
  const ext = fileExtension(file.fileName);
  const type = String(file.contentType ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"].includes(ext) || type.startsWith("image/")) {
    return "image";
  }
  if (isVideoExtension(ext) || type.startsWith("video/")) return "video";
  if (ext === "pdf" || type === "application/pdf") return "pdf";
  if (ext === "txt" || ext === "log" || ext === "csv" || type.startsWith("text/")) return "text";
  return "file";
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function trimZero(fixed: string): string {
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/** Human size for a chip — "820 KB", "2.4 MB". "" for anything that isn't a size. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value < 100 ? trimZero(value.toFixed(1)) : String(Math.round(value));
  // 1,023.96 KB rounds to "1024 KB" — that's "1 MB".
  if (Number(text) >= 1024 && unit < units.length - 1) return `1 ${units[unit + 1]}`;
  return `${text} ${units[unit]}`;
}

/**
 * Where a file link points. The session route for a signed-in page, the
 * token route for an emailed-link page — never the bucket, so every click is
 * re-authorized and the URL on the page is worthless once copied off it.
 */
export function attachmentHref(access: AttachmentAccess, attachmentId: string): string {
  const id = encodeURIComponent(attachmentId);
  return access.kind === "token"
    ? `/support/t/${encodeURIComponent(access.token)}/files/${id}`
    : `/support/files/${id}`;
}

/**
 * Add a download filename to a signed URL.
 *
 * Done here rather than with createSignedUrl's own `download` option, because
 * storage-js runs that option through URLSearchParams AND then encodeURI over
 * the whole URL, which double-encodes every non-ASCII character:
 * "résumé.pdf" reaches the reader's disk as "r%C3%A9sum%C3%A9.pdf". One
 * encodeURIComponent is the encoding the storage server undoes.
 */
export function withDownloadName(signedUrl: string, fileName: string): string {
  const sep = signedUrl.includes("?") ? "&" : "?";
  return `${signedUrl}${sep}download=${encodeURIComponent(fileName)}`;
}

/**
 * Split a ticket's attachments into "on the original request" and "on reply
 * X", for a thread that renders each message's files under it. A plain record
 * rather than a Map, so it can cross from a server component into a client one.
 */
export function groupAttachmentsByReply<T extends { replyId: string | null }>(
  items: readonly T[],
): { request: T[]; byReply: Record<string, T[]> } {
  const request: T[] = [];
  const byReply: Record<string, T[]> = {};
  for (const item of items) {
    if (!item.replyId) request.push(item);
    else (byReply[item.replyId] ??= []).push(item);
  }
  return { request, byReply };
}

// ---------------------------------------------------------------------------
// Who may attach, who may read
// ---------------------------------------------------------------------------

/**
 * May this signed-in person attach to this ticket? Theirs, and not closed —
 * the same line canRequesterReply (lib/support-access.ts) draws for replies,
 * because a file is part of a reply.
 */
export function requesterMayAttach(
  viewerId: string,
  ticket: { userId: string | null; status: string },
): boolean {
  return !!ticket.userId && ticket.userId === viewerId && ticket.status !== "closed";
}

/**
 * May this staff member attach to this ticket? Attaching is part of answering,
 * so it takes support.manage; on a confidential concern it also takes
 * support.sensitive, the rule every other surface of a sensitive ticket keeps.
 * Staff may attach to a closed ticket, as they may reply on one.
 */
export function staffMayAttach(
  staff: { canManage: boolean; canSeeSensitive: boolean },
  ticket: { sensitive: boolean },
): boolean {
  return staff.canManage && (!ticket.sensitive || staff.canSeeSensitive);
}

/**
 * The session download route's whole rule.
 *
 * Staff who can see the ticket — support.view or support.manage, plus
 * support.sensitive on a confidential concern — get every file on it,
 * internal ones included. The ticket's owner gets the files that aren't
 * internal. Nobody else gets anything, and the route answers them with the
 * same 404 as a file that doesn't exist.
 */
export function mayDownloadAttachment(
  viewer: { userId: string; canView: boolean; canSeeSensitive: boolean } | null,
  ticket: { userId: string | null; sensitive: boolean },
  attachment: { isInternal: boolean },
): boolean {
  if (!viewer) return false;
  if (viewer.canView && (!ticket.sensitive || viewer.canSeeSensitive)) return true;
  return !!ticket.userId && ticket.userId === viewer.userId && !attachment.isInternal;
}

/**
 * The token route's rule: the attachment has to be on the ticket the token
 * opens, and not internal. A token is the requester's credential, so it never
 * reaches a file the requester couldn't see on their own thread.
 */
export function tokenMayDownloadAttachment(
  ticket: { id: string },
  attachment: { ticketId: string; isInternal: boolean },
): boolean {
  return attachment.ticketId === ticket.id && !attachment.isInternal;
}
