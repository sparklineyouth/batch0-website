import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ATTACHMENT_MAX_BYTES,
  CHAT_FILES_BUCKET,
  CHAT_FILE_URL_TTL_SECONDS,
  chatUploadPath,
  isBlockedContentType,
  normalizeContentType,
  parseStagedChatFiles,
  validateUploadRequest,
  type ChatAttachment,
} from "@/lib/chat-files-rules";

/**
 * Server side of chat attachments (lib/chat-files-rules.ts has the flow).
 * The bucket has no storage.objects policy at all, so every byte in and out
 * goes through these functions, after the caller's channel check.
 */

export type MintedChatUpload = { path: string; token: string; name: string };

/** One-shot upload URLs for files the caller may post in this channel. */
export async function mintChatUploads(
  channelId: string,
  userId: string,
  rawFiles: unknown,
): Promise<{ ok: true; uploads: MintedChatUpload[] } | { ok: false; error: string }> {
  const checked = validateUploadRequest(rawFiles);
  if (!checked.ok) return checked;
  const bucket = createAdminClient().storage.from(CHAT_FILES_BUCKET);
  const uploads: MintedChatUpload[] = [];
  for (const f of checked.files) {
    const path = chatUploadPath(channelId, userId, randomUUID(), f.name);
    const { data, error } = await bucket.createSignedUploadUrl(path);
    if (error || !data) {
      console.error("[chat-files] mint failed", error?.message);
      return { ok: false, error: "Couldn't get that file ready to upload. Try again." };
    }
    uploads.push({ path, token: data.token, name: f.name });
  }
  return { ok: true, uploads };
}

/**
 * The staged files for a message, verified: each path minted for this channel
 * and sender, actually in storage, within the size limit, and not active
 * content. What the browser said about size and type is replaced by what
 * storage recorded. All-or-nothing, so a message never posts with a file
 * quietly missing.
 */
export async function verifyChatUploads(
  raw: unknown,
  channelId: string,
  userId: string,
): Promise<{ ok: true; attachments: ChatAttachment[] } | { ok: false; error: string }> {
  const parsed = parseStagedChatFiles(raw, channelId, userId);
  if (!parsed.ok) return parsed;
  if (parsed.files.length === 0) return { ok: true, attachments: [] };
  const bucket = createAdminClient().storage.from(CHAT_FILES_BUCKET);
  const attachments: ChatAttachment[] = [];
  for (const f of parsed.files) {
    const slash = f.path.lastIndexOf("/");
    const { data, error } = await bucket.list(f.path.slice(0, slash), { search: f.path.slice(slash + 1), limit: 5 });
    if (error) return { ok: false, error: "Couldn't check your attachments. Try sending again." };
    const hit = (data ?? []).find((o) => o.name === f.path.slice(slash + 1)) as
      | { metadata?: { size?: unknown; mimetype?: unknown } | null }
      | undefined;
    if (!hit) return { ok: false, error: `${f.name} didn't finish uploading. Attach it again.` };
    const size = Number(hit.metadata?.size ?? 0);
    const type = normalizeContentType(String(hit.metadata?.mimetype ?? ""));
    if (!(size > 0) || size > ATTACHMENT_MAX_BYTES || isBlockedContentType(type)) {
      await bucket.remove([f.path]).catch(() => undefined);
      return { ok: false, error: `${f.name} can't be attached.` };
    }
    attachments.push({ path: f.path, name: f.name, size, type });
  }
  return { ok: true, attachments };
}

/** A 10-minute URL for one stored file. */
export async function signChatFile(path: string, opts: { downloadName?: string } = {}): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .storage.from(CHAT_FILES_BUCKET)
    .createSignedUrl(path, CHAT_FILE_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return null;
  if (!opts.downloadName) return data.signedUrl;
  const sep = data.signedUrl.includes("?") ? "&" : "?";
  return `${data.signedUrl}${sep}download=${encodeURIComponent(opts.downloadName)}`;
}

/** Objects per page when listing a folder; storage's own default. */
const LIST_PAGE = 100;

/**
 * Every object directly inside one folder of the bucket (files only, not
 * subfolders). Throws when a page can't be listed: an error must never read
 * as "nothing there" to a caller about to decide what to keep.
 */
async function listFolderFiles(folder: string): Promise<{ path: string; createdAt: string | null }[]> {
  const bucket = createAdminClient().storage.from(CHAT_FILES_BUCKET);
  const out: { path: string; createdAt: string | null }[] = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await bucket.list(folder, { limit: LIST_PAGE, offset });
    if (error) throw new Error(`Couldn't list chat files: ${error.message}`);
    const page = (data ?? []) as { name: string; id: string | null; created_at?: string | null }[];
    // A folder comes back with no id.
    for (const o of page) if (o.id) out.push({ path: `${folder}/${o.name}`, createdAt: o.created_at ?? null });
    if (page.length < LIST_PAGE) return out;
  }
}

/** The subfolder names directly inside one folder (`<channel>/` holds one per uploader). */
async function listSubfolders(folder: string): Promise<string[]> {
  const bucket = createAdminClient().storage.from(CHAT_FILES_BUCKET);
  const out: string[] = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await bucket.list(folder, { limit: LIST_PAGE, offset });
    if (error) throw new Error(`Couldn't list chat files: ${error.message}`);
    const page = (data ?? []) as { name: string; id: string | null }[];
    for (const o of page) if (!o.id) out.push(o.name);
    if (page.length < LIST_PAGE) return out;
  }
}

/** Delete these objects, a batch at a time. Throws on a failed batch. */
export async function removeChatFiles(paths: readonly string[]): Promise<void> {
  const bucket = createAdminClient().storage.from(CHAT_FILES_BUCKET);
  const unique = Array.from(new Set(paths.filter((p) => typeof p === "string" && p.length > 0)));
  for (let i = 0; i < unique.length; i += 100) {
    const { error } = await bucket.remove(unique.slice(i, i + 100));
    if (error) throw new Error(`Couldn't delete chat files: ${error.message}`);
  }
}

/**
 * Everything one uploader staged in one channel's folder
 * (`<channel>/<uploader>/…`): sent or not.
 */
export async function listStagedFiles(channelId: string, userId: string): Promise<{ path: string; createdAt: string | null }[]> {
  return listFolderFiles(`${channelId.toLowerCase()}/${userId.toLowerCase()}`);
}

/**
 * Take a deleted channel's files with it (a group whose last member left, a
 * channel staff deleted). Best effort and logged: the channel is already gone,
 * and a file nobody can reach any more is storage, not exposure.
 */
export async function removeChannelFiles(channelId: string): Promise<void> {
  try {
    const root = channelId.toLowerCase();
    for (const uploader of await listSubfolders(root)) {
      await removeChatFiles((await listFolderFiles(`${root}/${uploader}`)).map((f) => f.path));
    }
  } catch (err) {
    console.error("[chat-files] removing a deleted channel's files failed", channelId, err);
  }
}
