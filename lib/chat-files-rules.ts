// ---------------------------------------------------------------------------
// batch0 Chat — attachment rules, as pure functions.
//
// The same flow every upload in this repo uses (lib/support-attachment-rules.ts
// explains it): the server mints a one-shot upload URL for a path it built
// itself, the browser puts the bytes straight into the private `chat-files`
// bucket, the send action re-checks every path and reads the real size and
// type back out of storage before the message is written, and every view or
// download re-authorizes against the channel and redirects to a 10-minute
// URL. The allow-list, name cleaning and type checks are support's, shared,
// so "what can I attach" has one answer across the site.
// ---------------------------------------------------------------------------

import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES_LABEL,
  attachmentKind,
  checkAttachmentFile,
  displayFileName,
  fileExtension,
  formatBytes,
  isBlockedContentType,
  isImageType,
  nameForStoredFile,
  normalizeContentType,
  safeFileName,
  validateUploadRequest,
} from "./support-attachment-rules.ts";

export {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES_LABEL,
  attachmentKind,
  checkAttachmentFile,
  displayFileName,
  formatBytes,
  isBlockedContentType,
  normalizeContentType,
  validateUploadRequest,
};

export const CHAT_FILES_BUCKET = "chat-files";
/** Files on one message. */
export const CHAT_MAX_FILES = 5;
/** A download or image URL lives ten minutes: minted per view, dead once copied off the page. */
export const CHAT_FILE_URL_TTL_SECONDS = 60 * 10;

/** One file on a message, as stored in chat_messages.attachments. */
export type ChatAttachment = {
  path: string;
  name: string;
  size: number;
  type: string;
};

const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH_RE = new RegExp(`^(${UUID_SRC})/(${UUID_SRC})/${UUID_SRC}-[a-z0-9][a-z0-9._-]{0,99}$`);

/**
 * `<channel>/<uploader>/<random uuid>-<safe name>`. The channel and uploader
 * are in the path so the send action can refuse a file staged for another
 * channel or by another person, whatever the browser claims.
 */
export function chatUploadPath(channelId: string, userId: string, objectId: string, fileName: string): string {
  return `${channelId.toLowerCase()}/${userId.toLowerCase()}/${objectId.toLowerCase()}-${safeFileName(fileName)}`;
}

/** The channel and uploader a path was minted for, or null if it isn't one of ours. */
export function parseChatUploadPath(path: unknown): { channelId: string; userId: string } | null {
  if (typeof path !== "string" || path.length > 512) return null;
  const m = path.match(PATH_RE);
  return m ? { channelId: m[1], userId: m[2] } : null;
}

/** May this person attach this staged path to a message in this channel? */
export function mayAttachPath(path: unknown, channelId: string, userId: string): boolean {
  const parsed = parseChatUploadPath(path);
  return !!parsed && parsed.channelId === channelId.toLowerCase() && parsed.userId === userId.toLowerCase();
}

/**
 * The browser's list of staged files, narrowed: at most CHAT_MAX_FILES, each
 * a path minted for this channel and uploader, deduped. Names are re-derived
 * against the path's checked extension (nameForStoredFile), so a tampered
 * client can't label a PNG `setup.exe`.
 */
export function parseStagedChatFiles(
  raw: unknown,
  channelId: string,
  userId: string,
): { ok: true; files: { path: string; name: string }[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, files: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Those attachments didn't come through. Attach them again." };
  if (raw.length > CHAT_MAX_FILES) return { ok: false, error: `You can attach up to ${CHAT_MAX_FILES} files to one message.` };
  const out: { path: string; name: string }[] = [];
  for (const entry of raw) {
    const path = entry && typeof entry === "object" ? (entry as { path?: unknown }).path : undefined;
    if (!mayAttachPath(path, channelId, userId)) {
      return { ok: false, error: "Those attachments didn't come through. Attach them again." };
    }
    if (out.some((f) => f.path === path)) continue;
    out.push({ path: path as string, name: nameForStoredFile((entry as { name?: unknown }).name, path as string) });
  }
  return { ok: true, files: out };
}

/** Shown inline as an image: both the stored type and the name agree it's one a browser renders. */
export function isInlineImage(a: Pick<ChatAttachment, "name" | "type">): boolean {
  return isImageType(a.type) && ["png", "jpg", "jpeg", "gif", "webp"].includes(fileExtension(a.name));
}

/** Where a file is served from: a route that re-checks access on every request. */
export function chatFileHref(messageId: string, index: number, opts: { download?: boolean } = {}): string {
  return `/chat/files/${encodeURIComponent(messageId)}/${index}${opts.download ? "?download=1" : ""}`;
}

export const CHAT_FILES_HINT = `Images, PDFs, text or short videos · up to ${CHAT_MAX_FILES} files, ${formatBytes(ATTACHMENT_MAX_BYTES)} each`;
