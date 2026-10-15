import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { capabilitiesForRole } from "@/lib/roles";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { asUuid } from "@/lib/chat-access";
import { getChatViewer, listReadableChannels, pageAll, toAttachments } from "@/lib/chat";
import { listStagedFiles, removeChatFiles } from "@/lib/chat-files";
import type { Role } from "@/lib/types";

/**
 * Account deletion, for chat. A deleted account's messages stay in everyone
 * else's history (chat_messages.sender_id goes null with the profile), so
 * before the account goes, what they wrote goes: each message is blanked in
 * place and marked deleted (the same blank a delete makes, so every screen
 * and the channel preview update), its earlier versions in
 * chat_message_revisions are deleted, and their files leave storage — what
 * they attached and anything they staged and never sent.
 *
 * Except evidence. A message someone reported, and every message in a DM or
 * group someone reported, stays exactly as it is, revisions and files
 * included: deleting your account must not be a way to make a report about
 * you disappear. (A report on a text channel is about one message, so only
 * that one is kept there.)
 *
 * Idempotent: a second run finds the blanked messages already blank and
 * their revisions already gone. Throws on any failure, so the caller stops
 * before deleting the account and can simply run it again; before migration
 * 0101 there's nothing to purge.
 */
export async function purgeChatContentFor(userId: string): Promise<void> {
  const uid = asUuid(userId);
  if (!uid) throw new Error("That account isn't one.");
  const admin = createAdminClient();

  let messages: { id: string; channel_id: string; attachments: unknown; deleted_at: string | null }[];
  try {
    messages = await pageAll((from, to) =>
      admin
        .from("chat_messages")
        .select("id, channel_id, attachments, deleted_at")
        .eq("sender_id", uid)
        .order("id")
        .range(from, to),
      "their messages",
    );
  } catch (err) {
    if (isMissingSchemaError(err)) return;
    throw err;
  }

  const channelIds = uniq(messages.map((m) => m.channel_id));
  const evidence = await evidenceAmong(messages, channelIds);
  const purge = messages.filter((m) => !evidence.has(m.id));
  const purgeIds = purge.map((m) => m.id);

  // What their messages hold and held: current attachments and every
  // revision's. Kept messages' files are never touched.
  const [purgedRevisionFiles, keptFiles] = await Promise.all([
    revisionPaths(purgeIds),
    keptPaths(messages.filter((m) => evidence.has(m.id))),
  ]);
  const files = new Set<string>([...purge.flatMap((m) => toAttachments(m.attachments).map((a) => a.path)), ...purgedRevisionFiles]);

  // Blank the live ones. The revision trigger saves what each said on the
  // way, which the next step deletes along with the older versions.
  const now = new Date().toISOString();
  for (const part of chunks(purge.filter((m) => !m.deleted_at).map((m) => m.id))) {
    const { error } = await admin
      .from("chat_messages")
      .update({ body: "", attachments: [], deleted_at: now, deleted_by: null, pinned_at: null, pinned_by: null })
      .in("id", part)
      .is("deleted_at", null);
    if (error) throw new Error(`Couldn't remove their chat messages: ${error.message}`);
  }
  for (const part of chunks(purgeIds)) {
    const { error } = await admin.from("chat_message_revisions").delete().in("message_id", part);
    if (error) throw new Error(`Couldn't remove their earlier versions: ${error.message}`);
  }

  // Their folders in every channel they could have uploaded to: files on
  // purged messages, and files staged and never sent.
  for (const path of await stagedPaths(uid, channelIds)) files.add(path);
  await removeChatFiles(Array.from(files).filter((p) => !keptFiles.has(p)));
}

const uniq = <T,>(xs: Iterable<T>): T[] => Array.from(new Set(xs));

function chunks<T>(items: readonly T[], size = 150): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Which of these messages are evidence: reported themselves, or in a reported DM or group. */
async function evidenceAmong(messages: readonly { id: string; channel_id: string }[], channelIds: readonly string[]): Promise<Set<string>> {
  const admin = createAdminClient();
  const reportedMessages = new Set<string>();
  const reportedConversations = new Set<string>();
  for (const part of chunks(channelIds)) {
    const [reports, kinds] = await Promise.all([
      pageAll<{ channel_id: string; message_id: string | null }>(
        (from, to) => admin.from("chat_reports").select("channel_id, message_id").in("channel_id", part).order("id").range(from, to),
        "reports",
      ),
      admin.from("chat_channels").select("id, kind").in("id", part),
    ]);
    if (kinds.error) throw new Error(`Couldn't load channels: ${kinds.error.message}`);
    const kindOf = new Map(((kinds.data ?? []) as { id: string; kind: string }[]).map((c) => [c.id, c.kind]));
    for (const r of reports) {
      if (r.message_id) reportedMessages.add(r.message_id);
      if (kindOf.get(r.channel_id) !== "channel") reportedConversations.add(r.channel_id);
    }
  }
  return new Set(messages.filter((m) => reportedMessages.has(m.id) || reportedConversations.has(m.channel_id)).map((m) => m.id));
}

async function revisionPaths(messageIds: readonly string[]): Promise<string[]> {
  const admin = createAdminClient();
  const out: string[] = [];
  for (const part of chunks(messageIds)) {
    const rows = await pageAll<{ attachments: unknown }>(
      (from, to) => admin.from("chat_message_revisions").select("id, attachments").in("message_id", part).order("id").range(from, to),
      "revisions",
    );
    for (const r of rows) for (const a of toAttachments(r.attachments)) out.push(a.path);
  }
  return out;
}

/** Every file a kept (evidence) message holds or held. */
async function keptPaths(kept: readonly { id: string; attachments: unknown }[]): Promise<Set<string>> {
  const out = new Set<string>(kept.flatMap((m) => toAttachments(m.attachments).map((a) => a.path)));
  for (const path of await revisionPaths(kept.map((m) => m.id))) out.add(path);
  return out;
}

/**
 * Everything in this person's upload folders: the channels they posted in,
 * are a member of, or can read (where they could have staged a file and
 * never sent it).
 */
async function stagedPaths(uid: string, posted: readonly string[]): Promise<string[]> {
  const admin = createAdminClient();
  const { data: profile, error } = await admin.from("profiles").select("role").eq("id", uid).maybeSingle();
  if (error) throw new Error(`Couldn't load the account: ${error.message}`);
  const caps = await capabilitiesForRole(((profile as { role?: Role } | null)?.role ?? "student") as Role);
  const readable = (await listReadableChannels(await getChatViewer(uid, caps))).map((c) => c.id);
  const channels = uniq([...posted, ...readable]);
  const out: string[] = [];
  // A few folders at a time: one list call each, mostly empty.
  for (const part of chunks(channels, 8)) {
    const listed = await Promise.all(part.map((c) => listStagedFiles(c, uid)));
    for (const files of listed) for (const f of files) out.push(f.path);
  }
  return out;
}
