import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyMany } from "@/lib/notifications";
import { shouldBell, wantsBell, type NotifyPref } from "@/lib/chat-access";
import {
  getChannelRow,
  getPerson,
  listChannelAudienceIds,
  listMembers,
  getPeople,
  readersAmong,
  type ChannelRow,
} from "@/lib/chat";
import { groupDisplayName } from "@/lib/chat-access";

/**
 * Who hears about a new chat message, and how.
 *
 *   DM / group  every other member, by default
 *   channel     people it mentions (and everyone, for a staff @everyone),
 *               plus anyone who set the channel to "All messages"
 *
 * then, per recipient: their notification setting for the channel (muted
 * means nothing), whether they've blocked the sender (then nothing — a block
 * is silence), and one bell per burst: none while an unread chat bell for the
 * channel already points at it, none while they're looking at it right now.
 *
 * In-app bells only. No email: a chat is a conversation, and mailing every
 * line would make it unusable. And no body, ever — admins can read every
 * notification (0016), so the words would be a staff read path into DMs;
 * migration 0101 strips any body in SQL as well.
 */

export const CHAT_BELL_TYPES = ["chat_dm", "chat_mention", "chat_message"] as const;

export function chatLink(channelId: string): string {
  return `/chat?c=${channelId}`;
}

/** Ids per lookup: a GET with `in.(…)` past ~150 uuids outgrows the gateway's URL limit. */
const LOOKUP_CHUNK = 150;

/**
 * Run one `.in(column, ids)` lookup per chunk and concatenate the rows. Any
 * failed chunk throws: a lookup that silently came back empty would read as
 * "no mutes, no blocks, no pending bell" and ring exactly the people who
 * asked for silence.
 */
async function lookupAll<T>(ids: readonly string[], run: (part: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const { data, error } = await run(ids.slice(i, i + LOOKUP_CHUNK));
    if (error) throw new Error(`Couldn't check chat bells: ${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

export async function notifyNewMessage(input: {
  channelId: string;
  messageId: string;
  senderId: string;
  mentions: readonly string[];
  mentionEveryone: boolean;
  channel?: ChannelRow;
}): Promise<void> {
  const channel = input.channel ?? (await getChannelRow(input.channelId));
  if (!channel) return;
  const admin = createAdminClient();

  // Candidates and whether each one was mentioned.
  const mentioned = new Set(input.mentions);
  let candidates: string[];
  if (channel.kind === "channel") {
    const { data: allPrefs, error } = await admin
      .from("chat_reads")
      .select("user_id")
      .eq("channel_id", channel.id)
      .eq("notify", "all")
      .limit(2000);
    if (error) throw new Error(`Couldn't check chat bells: ${error.message}`);
    // A preference outlives access: nothing deletes chat_reads when someone
    // leaves a team or a private channel, or a channel's audience narrows.
    // So "All messages" is re-vetted against who can read it right now —
    // otherwise a bell would tell them who's posting where they can't look.
    const subscribed = await readersAmong(channel, ((allPrefs ?? []) as any[]).map((r) => r.user_id));
    const everyone = input.mentionEveryone ? await listChannelAudienceIds(channel) : [];
    candidates = Array.from(new Set([...input.mentions, ...everyone, ...subscribed]));
    if (input.mentionEveryone) for (const id of everyone) mentioned.add(id);
  } else {
    candidates = (await listMembers([channel.id])).get(channel.id) ?? [];
  }
  candidates = candidates.filter((id) => id && id !== input.senderId);
  if (candidates.length === 0) return;

  const link = chatLink(channel.id);
  const [reads, bells, blocks] = await Promise.all([
    lookupAll<{ user_id: string; seen_at: string | null; notify: NotifyPref | null }>(candidates, (part) =>
      admin.from("chat_reads").select("user_id, seen_at, notify").eq("channel_id", channel.id).in("user_id", part),
    ),
    lookupAll<{ user_id: string }>(candidates, (part) =>
      admin
        .from("notifications")
        .select("user_id")
        .in("user_id", part)
        .eq("link", link)
        .in("type", CHAT_BELL_TYPES as unknown as string[])
        .is("read_at", null),
    ),
    lookupAll<{ blocker_id: string }>(candidates, (part) =>
      admin.from("chat_blocks").select("blocker_id").eq("blocked_id", input.senderId).in("blocker_id", part),
    ),
  ]);
  const readBy = new Map(reads.map((r) => [r.user_id, r]));
  const pending = new Set(bells.map((r) => r.user_id));
  const blockedBy = new Set(blocks.map((r) => r.blocker_id));

  const now = Date.now();
  const recipients = candidates.filter((id) => {
    if (blockedBy.has(id)) return false;
    const read = readBy.get(id);
    if (!wantsBell(channel.kind, read?.notify ?? null, mentioned.has(id))) return false;
    return shouldBell({ recipientSeenAt: read?.seen_at ?? null, hasUnreadBell: pending.has(id) }, now);
  });
  if (recipients.length === 0) return;

  const sender = (await getPerson(input.senderId))?.name ?? "Someone";
  let groupName = "";
  if (channel.kind === "group") {
    const members = (await listMembers([channel.id])).get(channel.id) ?? [];
    const people = await getPeople(members);
    groupName = groupDisplayName(
      channel.name,
      members.map((id) => ({ id, name: people.get(id)?.name ?? "Deleted account" })),
      "",
    );
  }

  await notifyMany(
    recipients.map((userId) => {
      if (channel.kind === "dm") return { userId, type: "chat_dm", title: `${sender} messaged you`, link };
      if (channel.kind === "group") return { userId, type: "chat_dm", title: `${sender} in ${groupName}`, link };
      if (mentioned.has(userId)) {
        return {
          userId,
          type: "chat_mention",
          title: input.mentionEveryone && !input.mentions.includes(userId)
            ? `${sender} pinged everyone in #${channel.name}`
            : `${sender} mentioned you in #${channel.name}`,
          link,
        };
      }
      return { userId, type: "chat_message", title: `${sender} posted in #${channel.name}`, link };
    }),
  );
}

/** Take down this person's chat bells for a channel they've now caught up on. */
export async function clearChannelBells(userId: string, channelId: string): Promise<number> {
  const { data } = await createAdminClient()
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("link", chatLink(channelId))
    .in("type", CHAT_BELL_TYPES as unknown as string[])
    .is("read_at", null)
    .select("id");
  return data?.length ?? 0;
}
