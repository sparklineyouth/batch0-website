import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyMany } from "@/lib/notifications";
import { bellTitle, isAfter, shouldBell, wantsBell, type NotifyPref } from "@/lib/chat-access";
import {
  THREAD_BELL_TYPE,
  THREAD_BELL_TYPES,
  bellFresh,
  threadBellRecipients,
  threadBellTitle,
  threadLink,
} from "@/lib/chat-threads-rules";
import {
  getChannelRow,
  getPerson,
  listChannelAudienceIds,
  listMembers,
  readersAmong,
  type ChannelRow,
} from "@/lib/chat";

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
 * And one bell per message, however often this runs for it: each carries
 * `chat-message:<id>` as its dedupe key, so the notifications index turns a
 * second one for the same person into nothing. A replayed send (a Retry of a
 * message that already went in, app/chat/actions.ts) asks for its bells again
 * on that strength, with `postedAt`, in case the first request died before
 * ringing them.
 *
 * In-app bells only. No email: a chat is a conversation, and mailing every
 * line would make it unusable. And no body, ever — admins can read every
 * notification (0016), so the words would be a staff read path into DMs;
 * migration 0101 strips any body in SQL as well. For the same reason a
 * group's bell never names the group or its members (bellTitle).
 */

export const CHAT_BELL_TYPES = ["chat_dm", "chat_mention", "chat_message"] as const;

export { THREAD_BELL_TYPE };

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
  /** People who get no chat bell for this one (an announcement's own recipients already have theirs). */
  excludeBells?: readonly string[];
  /**
   * When the message went in, for bells asked for again after it did (a
   * replayed send): nobody whose read cursor is already there is belled. A
   * new message never needs it — nobody has read past something just posted.
   */
  postedAt?: string;
}): Promise<void> {
  const channel = input.channel ?? (await getChannelRow(input.channelId));
  if (!channel) return;
  const admin = createAdminClient();

  // Candidates and whether each one was mentioned.
  const mentioned = new Set(input.mentions);
  let candidates: string[];
  if (channel.kind === "channel") {
    const allPrefs: string[] = [];
    // Paged: PostgREST stops at 1000 rows without saying so.
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin
        .from("chat_reads")
        .select("user_id")
        .eq("channel_id", channel.id)
        .eq("notify", "all")
        .order("user_id")
        .range(from, from + 999);
      if (error) throw new Error(`Couldn't check chat bells: ${error.message}`);
      allPrefs.push(...((data ?? []) as { user_id: string }[]).map((r) => r.user_id));
      if ((data ?? []).length < 1000) break;
    }
    // A preference outlives access: nothing deletes chat_reads when someone
    // leaves a team or a private channel, or a channel's audience narrows.
    // So "All messages" is re-vetted against who can read it right now —
    // otherwise a bell would tell them who's posting where they can't look.
    const subscribed = await readersAmong(channel, allPrefs);
    const everyone = input.mentionEveryone ? await listChannelAudienceIds(channel) : [];
    candidates = Array.from(new Set([...input.mentions, ...everyone, ...subscribed]));
    if (input.mentionEveryone) for (const id of everyone) mentioned.add(id);
  } else {
    candidates = (await listMembers([channel.id])).get(channel.id) ?? [];
  }
  const excluded = new Set(input.excludeBells ?? []);
  candidates = candidates.filter((id) => id && id !== input.senderId && !excluded.has(id));
  if (candidates.length === 0) return;

  const link = chatLink(channel.id);
  const [reads, bells, blocks] = await Promise.all([
    lookupAll<{ user_id: string; seen_at: string | null; notify: NotifyPref | null; last_read_at: string | null }>(candidates, (part) =>
      admin.from("chat_reads").select("user_id, seen_at, notify, last_read_at").eq("channel_id", channel.id).in("user_id", part),
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
    if (input.postedAt && read?.last_read_at && !isAfter(input.postedAt, read.last_read_at)) return false;
    if (!wantsBell(channel.kind, read?.notify ?? null, mentioned.has(id))) return false;
    return shouldBell({ recipientSeenAt: read?.seen_at ?? null, hasUnreadBell: pending.has(id) }, now);
  });
  if (recipients.length === 0) return;

  const sender = (await getPerson(input.senderId))?.name ?? "Someone";
  await notifyMany(
    recipients.map((userId) => {
      const isMention = channel.kind === "channel" && mentioned.has(userId);
      return {
        userId,
        type: channel.kind === "channel" ? (isMention ? "chat_mention" : "chat_message") : "chat_dm",
        title: bellTitle(channel.kind, {
          sender,
          channelName: channel.name,
          mentioned: isMention,
          everyone: isMention && input.mentionEveryone && !input.mentions.includes(userId),
        }),
        link,
        dedupeKey: `chat-message:${input.messageId}`,
      };
    }),
  );
}

/**
 * Take down this person's chat bells for a channel they've now caught up on.
 * A failure is logged and counts as nothing cleared: the bell stays up, which
 * is the honest state, and the read cursor already moved.
 */
export async function clearChannelBells(userId: string, channelId: string): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("link", chatLink(channelId))
    .in("type", CHAT_BELL_TYPES as unknown as string[])
    .is("read_at", null)
    .select("id");
  if (error) {
    console.error("[chat] clearing bells failed", error.message);
    return 0;
  }
  return data?.length ?? 0;
}

/** Links per update. The filter rides in the URL, and a link is longer than a bare id (LOOKUP_CHUNK). */
const CLEAR_CHUNK = 100;

/**
 * Take down this person's chat bells for many channels at once ("Mark all
 * read"): one update per hundred channels, one after another — not one per
 * channel all in flight together, which for a staff inbox of a thousand DMs
 * was a thousand sockets from one action. A failure throws: the read cursors
 * have already moved, so the caller should hear that bells stayed up (and
 * can simply run it again) rather than count them as cleared.
 */
export async function clearChannelBellsMany(userId: string, channelIds: readonly string[]): Promise<number> {
  const links = Array.from(new Set(channelIds.map(chatLink)));
  const admin = createAdminClient();
  const readAt = new Date().toISOString();
  let cleared = 0;
  for (let i = 0; i < links.length; i += CLEAR_CHUNK) {
    const { data, error } = await admin
      .from("notifications")
      .update({ read_at: readAt })
      .eq("user_id", userId)
      .in("link", links.slice(i, i + CLEAR_CHUNK))
      .in("type", CHAT_BELL_TYPES as unknown as string[])
      .is("read_at", null)
      .select("id");
    if (error) throw new Error(`Couldn't clear chat bells: ${error.message}`);
    cleared += data?.length ?? 0;
  }
  return cleared;
}

/**
 * Who hears about a thread reply (migration 0110), and how. Only the
 * thread's followers (its author and its repliers by default, minus anyone
 * who unfollowed) and the people the reply @mentions — never a channel's
 * "All messages" list and never @everyone, so a busy thread rings a handful
 * of people, not a cohort. Then the channel's rules, per person
 * (threadBellRecipients): still a reader of the channel right now (a follow
 * grants nothing), no block of the sender, the channel not muted, and one
 * bell per burst — none while an unread one for the thread is up, none while
 * they had it open a moment ago. One bell per message, however often this
 * runs (the same dedupe key as a channel bell), and none at all for a reply
 * that isn't fresh: history carried in later rings nobody (bellFresh).
 */
export async function notifyThreadReply(input: {
  channel: ChannelRow;
  rootId: string;
  messageId: string;
  senderId: string;
  /** The reply's vetted mentions (pingsFor in app/chat/actions.ts). */
  mentions: readonly string[];
  /** When the reply went in. */
  createdAt: string;
  /** Asked for again by a replayed send: skip whoever has opened the thread since. */
  postedAt?: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const { channel } = input;
  if (channel.kind !== "channel" || !bellFresh(input.createdAt, now)) return;
  const admin = createAdminClient();

  const followRows: { user_id: string; state: string | null; seen_at: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("chat_thread_follows")
      .select("user_id, state, seen_at")
      .eq("root_id", input.rootId)
      .order("user_id")
      .range(from, from + 999);
    if (error) throw new Error(`Couldn't check thread bells: ${error.message}`);
    followRows.push(...((data ?? []) as typeof followRows));
    if ((data ?? []).length < 1000) break;
  }
  const follows = new Map(followRows.map((r) => [r.user_id, r]));
  const mentioned = new Set(input.mentions);
  const ids = Array.from(
    new Set([...followRows.filter((r) => r.state === "following").map((r) => r.user_id), ...input.mentions]),
  ).filter((id) => id && id !== input.senderId);
  if (ids.length === 0) return;

  const link = threadLink(channel.id, input.rootId);
  const [readers, reads, bells, blocks] = await Promise.all([
    readersAmong(channel, ids),
    lookupAll<{ user_id: string; notify: NotifyPref | null }>(ids, (part) =>
      admin.from("chat_reads").select("user_id, notify").eq("channel_id", channel.id).in("user_id", part),
    ),
    lookupAll<{ user_id: string }>(ids, (part) =>
      admin
        .from("notifications")
        .select("user_id")
        .in("user_id", part)
        .eq("link", link)
        .in("type", THREAD_BELL_TYPES as unknown as string[])
        .is("read_at", null),
    ),
    lookupAll<{ blocker_id: string }>(ids, (part) =>
      admin.from("chat_blocks").select("blocker_id").eq("blocked_id", input.senderId).in("blocker_id", part),
    ),
  ]);
  const readerSet = new Set(readers);
  const prefs = new Map(reads.map((r) => [r.user_id, r.notify]));
  const pending = new Set(bells.map((r) => r.user_id));
  const blockedBy = new Set(blocks.map((r) => r.blocker_id));

  const recipients = threadBellRecipients(
    ids.map((userId) => ({
      userId,
      following: follows.get(userId)?.state === "following",
      mentioned: mentioned.has(userId),
      reader: readerSet.has(userId),
      blockedSender: blockedBy.has(userId),
      channelPref: prefs.get(userId) ?? null,
      seenAt: follows.get(userId)?.seen_at ?? null,
      hasUnreadBell: pending.has(userId),
    })),
    { senderId: input.senderId, nowMs: now, postedAt: input.postedAt },
  );
  if (recipients.length === 0) return;

  const sender = (await getPerson(input.senderId))?.name ?? "Someone";
  await notifyMany(
    recipients.map((r) => ({
      userId: r.userId,
      type: r.mentioned ? "chat_mention" : THREAD_BELL_TYPE,
      title: threadBellTitle({ sender, channelName: channel.name, mentioned: r.mentioned }),
      link,
      dedupeKey: `chat-message:${input.messageId}`,
    })),
  );
}
