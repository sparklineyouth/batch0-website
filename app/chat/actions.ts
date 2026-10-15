"use server";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/server-guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { notifyMany } from "@/lib/notifications";
import { runAction, type ActionResult } from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import {
  canDeleteMessage,
  canEditMessage,
  canMentionEveryone,
  canPin,
  canPost,
  canStartGroup,
  dmKey,
  GROUP_MAX_MEMBERS,
  GROUP_NAME_MAX,
  isAllowedReaction,
  isParticipant,
  isUuid,
  laterTimestamp,
  MESSAGE_MAX,
  otherInDmKey,
  REPORT_REASON_MAX,
  SAFEGUARD_REASON,
  slowModeWait,
  type ChatViewer,
  type NotifyPref,
  type ReactionMap,
} from "@/lib/chat-access";
import { mentionedIds, mentionsEveryone } from "@/lib/chat-format";
import {
  buildSidebar,
  canStartConversation,
  countAttention,
  filterReaders,
  findDm,
  getChannelForViewer,
  getChatViewer,
  getMessageRow,
  getMessages,
  getPeople,
  getPerson,
  hasPendingFine,
  isBlockedBetween,
  lastSentAt,
  listBlockedPeople,
  listChannelPeople,
  listMembers,
  listMessages,
  listModeratorIds,
  listPins,
  membershipAllowed,
  searchDirectory,
  searchMessages as searchMessagesIn,
  type ChannelRow,
  type ChatMessage,
  type ChatPerson,
  type SidebarData,
} from "@/lib/chat";
import { buildChannelPayload, peopleIn, type ChannelPayload, type ChannelTarget } from "@/lib/chat-payload";
import { clearChannelBells, notifyNewMessage } from "@/lib/chat-notify";
import { mintChatUploads, verifyChatUploads, type MintedChatUpload } from "@/lib/chat-files";

/**
 * Server actions for batch0 Chat (migration 0101).
 *
 * They double as the read API for the client: a server action is a narrower
 * door than a route handler — no URL to guess — and the actor and every rule
 * are re-derived here on every call. A page guard protects none of this.
 *
 * Reads return plain data and throw on failure. Mutations return an
 * ActionResult, because every interesting failure in a chat is one the person
 * needs to read: blocked, archived, slow mode, too long.
 *
 * Nothing here calls revalidatePath: /chat is force-dynamic and the client
 * owns its panes, and a revalidation would re-render the whole route behind
 * every message.
 */

async function viewerNow(): Promise<ChatViewer> {
  const actor = await requireActor();
  return getChatViewer(actor.userId, actor.caps);
}

const NOT_AVAILABLE = "That channel isn't available.";

function cleanBody(raw: unknown, { allowEmpty = false } = {}): string {
  const b = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "") : "";
  if (!b && !allowEmpty) throw new Error("Write a message first.");
  if (b.length > MESSAGE_MAX) throw new Error(`That message is too long (max ${MESSAGE_MAX.toLocaleString()} characters).`);
  return b;
}

async function rateLimit(kind: string, userId: string, limit: number, windowSeconds: number, message: string) {
  const rl = await checkRateLimit({ kind, identifier: userId, limit, windowSeconds });
  if (!rl.ok) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchSidebar(): Promise<SidebarData> {
  return buildSidebar(await viewerNow());
}

/** The nav badge: DMs and groups with something unread, plus channel mentions. */
export async function fetchAttention(): Promise<number> {
  try {
    return await countAttention(await viewerNow());
  } catch {
    return 0;
  }
}

export async function fetchChannel(target: ChannelTarget): Promise<ChannelPayload> {
  const payload = await buildChannelPayload(await viewerNow(), target);
  if (!payload) throw new Error(NOT_AVAILABLE);
  return payload;
}

/** Older messages for infinite scroll, newer ones after a jump, or a resync of the newest page. */
export async function fetchMessages(
  channelId: string,
  opts: { before?: string; around?: string } = {},
): Promise<{
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  people: Record<string, ChatPerson>;
  /** Everything created before this instant that isn't in `messages` (and is inside the page) is gone. */
  asOf: string;
}> {
  const viewer = await viewerNow();
  const found = await getChannelForViewer(channelId, viewer);
  if (!found) throw new Error(NOT_AVAILABLE);
  // Taken before the query, less a margin for clock skew, so a message that
  // lands mid-request is never mistaken for a deleted one.
  const asOf = new Date(Date.now() - 3_000).toISOString();
  const page = await listMessages(found.channel.id, opts);
  const people = await getPeople(peopleIn(page.messages));
  return { ...page, people: Object.fromEntries(people), asOf };
}

/** Messages by id — the realtime path hands the client ids it then hydrates. */
export async function fetchMessagesById(
  channelId: string,
  ids: string[],
): Promise<{ messages: ChatMessage[]; people: Record<string, ChatPerson> }> {
  const viewer = await viewerNow();
  const found = await getChannelForViewer(channelId, viewer);
  if (!found) throw new Error(NOT_AVAILABLE);
  const messages = (await getMessages(ids.slice(0, 50))).filter((m) => m.channelId === found.channel.id);
  const people = await getPeople(peopleIn(messages));
  return { messages, people: Object.fromEntries(people) };
}

export async function fetchMembers(channelId: string): Promise<ChatPerson[]> {
  const viewer = await viewerNow();
  const found = await getChannelForViewer(channelId, viewer);
  if (!found) throw new Error(NOT_AVAILABLE);
  return listChannelPeople(found.channel);
}

export async function fetchPins(channelId: string): Promise<{ messages: ChatMessage[]; people: Record<string, ChatPerson> }> {
  const viewer = await viewerNow();
  const found = await getChannelForViewer(channelId, viewer);
  if (!found) throw new Error(NOT_AVAILABLE);
  const messages = await listPins(found.channel.id);
  return { messages, people: Object.fromEntries(await getPeople(peopleIn(messages))) };
}

export async function searchMessages(
  query: string,
  channelId?: string | null,
): Promise<{ messages: ChatMessage[]; people: Record<string, ChatPerson> }> {
  const viewer = await viewerNow();
  await rateLimit("chat-search", viewer.userId, 30, 60, "Too many searches in a row. Give it a second.");
  const messages = await searchMessagesIn(viewer, String(query ?? "").slice(0, 200), channelId ?? null);
  return { messages, people: Object.fromEntries(await getPeople(peopleIn(messages))) };
}

export async function searchPeople(query: string): Promise<ChatPerson[]> {
  const viewer = await viewerNow();
  return searchDirectory(String(query ?? "").slice(0, 100), viewer);
}

export async function fetchBlockedPeople(): Promise<ChatPerson[]> {
  const actor = await requireActor();
  return listBlockedPeople(actor.userId);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * The DM with a person, created on the first message. Every check runs BEFORE
 * the row exists: creating it first would let a blocked sender push empty
 * conversations into the inbox of the person who blocked them.
 */
async function resolveDm(viewer: ChatViewer, toUserId: string): Promise<{ channelId: string; created: boolean }> {
  if (!isUuid(toUserId) || toUserId === viewer.userId) throw new Error("Pick someone to message.");
  const key = dmKey(viewer.userId, toUserId);
  const existing = await findDm(key);
  if (existing) return { channelId: existing.id, created: false };
  const person = await getPerson(toUserId);
  if (!person) throw new Error("That person isn't available.");
  const allowed = await canStartConversation(viewer, person);
  if (!allowed.ok) throw new Error(allowed.reason);
  if (await isBlockedBetween(viewer.userId, toUserId)) throw new Error("You can't send messages to this person.");
  await rateLimit(
    "chat-new-conversation",
    viewer.userId,
    10,
    3600,
    "You've started a lot of new conversations in the last hour. Try again later.",
  );
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("chat_channels")
    .insert({ kind: "dm", audience: "members", dm_key: key, created_by: viewer.userId })
    .select("id")
    .single();
  if (error) {
    // Both people pressed send at the same instant: one insert loses on the
    // unique key and reads the winner back.
    const again = await findDm(key);
    if (again) return { channelId: again.id, created: false };
    throw new Error(error.message);
  }
  const channelId = (data as { id: string }).id;
  const { error: memErr } = await admin.from("chat_members").insert([
    { channel_id: channelId, user_id: viewer.userId, added_by: viewer.userId },
    { channel_id: channelId, user_id: toUserId, added_by: viewer.userId },
  ]);
  if (memErr) throw new Error(memErr.message);
  return { channelId, created: true };
}

/** Everything that decides whether this viewer may post here right now. */
async function assertCanPost(viewer: ChatViewer, channel: ChannelRow, reported: boolean): Promise<void> {
  const participant = isParticipant(channel, viewer);
  let blocked = false;
  let otherPresent = true;
  let otherId: string | null = null;
  if (channel.kind === "dm" && participant) {
    otherId = otherInDmKey(channel.dmKey, viewer.userId);
    const members = (await listMembers([channel.id])).get(channel.id) ?? [];
    otherPresent = !!otherId && members.includes(otherId);
    blocked = otherId ? await isBlockedBetween(viewer.userId, otherId) : false;
  }
  const safeguarded =
    channel.kind !== "channel" && isParticipant(channel, viewer)
      ? !(await membershipAllowed((await listMembers([channel.id])).get(channel.id) ?? []))
      : false;
  const verdict = canPost(channel, viewer, { reported, blocked, otherPresent, safeguarded });
  if (!verdict.ok) throw new Error(verdict.reason);

  // A pending fine locks an account out of everything but paying it. One door
  // stays open: a DM with the team, to ask about the fine.
  if (!viewer.staff && (await hasPendingFine(viewer.userId))) {
    const other = otherId ? await getPerson(otherId) : null;
    if (!(channel.kind === "dm" && other?.isStaff)) {
      throw new Error("Settle your pending fine first. You can still message the batch0 team about it.");
    }
  }

  const wait = slowModeWait(channel, viewer, await lastSentAt(channel.id, viewer.userId), Date.now());
  if (wait > 0) throw new Error(`Slow mode is on. You can post again in ${wait}s.`);
}

export type SendInput = {
  channelId?: string;
  toUserId?: string;
  body: string;
  replyToId?: string | null;
  attachments?: { path: string; name: string }[];
};

export async function sendMessage(input: SendInput): Promise<ActionResult<{ channelId: string; message: ChatMessage }>> {
  return runAction({ name: "chat.send" }, async () => {
    const viewer = await viewerNow();
    const hasFiles = Array.isArray(input.attachments) && input.attachments.length > 0;
    const body = cleanBody(input.body, { allowEmpty: hasFiles });

    let channelId = input.channelId ?? null;
    let created = false;
    if (!channelId && input.toUserId) {
      // The fine lock and the block check run inside resolveDm/assertCanPost;
      // the new-conversation rate limit only when a row is actually created.
      ({ channelId, created } = await resolveDm(viewer, input.toUserId));
      if (created) viewer.memberOf = [...viewer.memberOf, channelId];
    }
    if (!channelId) throw new Error("Pick a channel or a person first.");

    const found = await getChannelForViewer(channelId, viewer);
    if (!found) throw new Error(NOT_AVAILABLE);
    const { channel, reported } = found;
    await assertCanPost(viewer, channel, reported);
    await rateLimit("chat-message", viewer.userId, 30, 60, "Slow down — too many messages in a row.");

    const files = await verifyChatUploads(input.attachments, channel.id, viewer.userId);
    if (!files.ok) throw new Error(files.error);

    let replyToId: string | null = null;
    if (input.replyToId) {
      const target = await getMessageRow(input.replyToId);
      if (!target || target.channel_id !== channel.id || target.deleted_at) {
        throw new Error("The message you're replying to is gone.");
      }
      replyToId = target.id;
    }

    const mentions = await filterReaders(channel, mentionedIds(body));
    const everyone = canMentionEveryone(channel, viewer) && mentionsEveryone(body);

    const admin = createAdminClient();
    const { data, error } = await admin
      .from("chat_messages")
      .insert({
        channel_id: channel.id,
        sender_id: viewer.userId,
        body,
        reply_to_id: replyToId,
        mentions,
        mention_everyone: everyone,
        attachments: files.attachments,
      })
      .select("id, created_at")
      .single();
    if (error) throw new Error(error.message);
    const row = data as { id: string; created_at: string };

    // The sender has read their own message; a closed conversation reopens.
    await admin.from("chat_reads").upsert(
      {
        channel_id: channel.id,
        user_id: viewer.userId,
        last_read_at: row.created_at,
        seen_at: new Date().toISOString(),
        hidden_at: null,
      },
      { onConflict: "channel_id,user_id" },
    );

    // Bells go out after the response: the sender shouldn't wait on them.
    after(async () => {
      try {
        await notifyNewMessage({
          channelId: channel.id,
          messageId: row.id,
          senderId: viewer.userId,
          mentions,
          mentionEveryone: everyone,
          channel,
        });
      } catch (err) {
        console.error("[chat] notify failed", err);
      }
    });

    const [message] = await getMessages([row.id]);
    if (!message) throw new Error("Sent, but couldn't load it back. Refresh to see it.");
    return { channelId: channel.id, message };
  });
}

export async function editMessage(messageId: string, rawBody: string): Promise<ActionResult<{ message: ChatMessage }>> {
  return runAction({ name: "chat.edit" }, async () => {
    const viewer = await viewerNow();
    const row = await getMessageRow(messageId);
    if (!row) throw new Error("That message is gone.");
    const found = await getChannelForViewer(row.channel_id, viewer);
    if (!found) throw new Error(NOT_AVAILABLE);
    if (!canEditMessage({ senderId: row.sender_id, kind: row.kind, deletedAt: row.deleted_at }, viewer)) {
      throw new Error("You can only edit your own messages.");
    }
    if (found.channel.archivedAt) throw new Error("This channel is archived. It's read-only now.");
    const hasFiles = Array.isArray(row.attachments) && row.attachments.length > 0;
    const body = cleanBody(rawBody, { allowEmpty: hasFiles });
    if (body === row.body) {
      const [same] = await getMessages([row.id]);
      return { message: same };
    }
    await rateLimit("chat-edit", viewer.userId, 30, 60, "Too many edits in a row. Give it a second.");
    // Edits don't ring bells (Discord doesn't either), but the mention list
    // follows the text so the unread badge stays honest.
    const mentions = await filterReaders(found.channel, mentionedIds(body));
    const everyone = row.mention_everyone || (canMentionEveryone(found.channel, viewer) && mentionsEveryone(body));
    const { error } = await createAdminClient()
      .from("chat_messages")
      .update({ body, mentions, mention_everyone: everyone, edited_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("deleted_at", null);
    if (error) throw new Error(error.message);
    const [message] = await getMessages([row.id]);
    if (!message) throw new Error("That message is gone.");
    return { message };
  });
}

/**
 * Delete a message: your own, or anyone's if you run chat. It vanishes for
 * everyone at once (blanked in place, so the Realtime update carries it), and
 * what it said stays in chat_message_revisions for the report queue — so
 * deleting first is no way to hide something from a report.
 */
export async function deleteMessage(messageId: string): Promise<ActionResult> {
  return runAction({ name: "chat.delete" }, async () => {
    const viewer = await viewerNow();
    const row = await getMessageRow(messageId);
    if (!row || row.deleted_at) throw new Error("That message is already gone.");
    const found = await getChannelForViewer(row.channel_id, viewer);
    if (!found) throw new Error("That message is already gone.");
    if (!canDeleteMessage({ senderId: row.sender_id, kind: row.kind, deletedAt: row.deleted_at }, found.channel, viewer)) {
      throw new Error("You can only delete your own messages.");
    }
    const { data, error } = await createAdminClient()
      .from("chat_messages")
      .update({
        body: "",
        attachments: [],
        deleted_at: new Date().toISOString(),
        deleted_by: viewer.userId,
        pinned_at: null,
        pinned_by: null,
      })
      .eq("id", row.id)
      .is("deleted_at", null)
      .select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error("That message is already gone.");
    if (row.sender_id !== viewer.userId) {
      await logAudit({
        action: "chat.message_remove",
        targetType: "chat_message",
        targetId: row.id,
        payload: { channelId: row.channel_id },
      });
    }
  });
}

export async function toggleReaction(messageId: string, emoji: string): Promise<ActionResult<{ reactions: ReactionMap }>> {
  return runAction({ name: "chat.react" }, async () => {
    const viewer = await viewerNow();
    if (!isAllowedReaction(emoji)) throw new Error("Pick a reaction from the list.");
    const row = await getMessageRow(messageId);
    if (!row || row.deleted_at) throw new Error("That message is gone.");
    const found = await getChannelForViewer(row.channel_id, viewer);
    if (!found) throw new Error(NOT_AVAILABLE);
    if (found.channel.archivedAt) throw new Error("This channel is archived. It's read-only now.");
    if (found.channel.kind !== "channel" && !isParticipant(found.channel, viewer)) {
      throw new Error("You're reading this as a moderator.");
    }
    await rateLimit("chat-react", viewer.userId, 60, 60, "Easy on the reactions — try again in a moment.");
    const admin = createAdminClient();
    const key = { message_id: row.id, user_id: viewer.userId, emoji };
    const { data: existing } = await admin.from("chat_reactions").select("emoji").match(key).maybeSingle();
    if (existing) {
      const { error } = await admin.from("chat_reactions").delete().match(key);
      if (error) throw new Error(error.message);
    } else {
      const { count } = await admin
        .from("chat_reactions")
        .select("emoji", { count: "exact", head: true })
        .eq("message_id", row.id);
      if ((count ?? 0) >= 200) throw new Error("That message has all the reactions it can hold.");
      const { error } = await admin
        .from("chat_reactions")
        .upsert(key, { onConflict: "message_id,user_id,emoji", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    }
    const { data: after } = await admin.from("chat_messages").select("reactions").eq("id", row.id).maybeSingle();
    return { reactions: ((after as any)?.reactions ?? {}) as ReactionMap };
  });
}

/** System lines ("Maya pinned a message.") are written as nobody, flagged system. */
async function postSystemLine(channelId: string, body: string) {
  await createAdminClient().from("chat_messages").insert({ channel_id: channelId, sender_id: null, kind: "system", body });
}

export async function togglePin(messageId: string): Promise<ActionResult<{ pinned: boolean }>> {
  return runAction({ name: "chat.pin" }, async () => {
    const viewer = await viewerNow();
    const row = await getMessageRow(messageId);
    if (!row || row.deleted_at || row.kind !== "message") throw new Error("That message is gone.");
    const found = await getChannelForViewer(row.channel_id, viewer);
    if (!found) throw new Error(NOT_AVAILABLE);
    if (!canPin(found.channel, viewer)) throw new Error("Only the batch0 team pins messages here.");
    if (found.channel.archivedAt) throw new Error("This channel is archived. It's read-only now.");
    const admin = createAdminClient();
    const pinning = !row.pinned_at;
    if (pinning) {
      const { count } = await admin
        .from("chat_messages")
        .select("id", { count: "exact", head: true })
        .eq("channel_id", row.channel_id)
        .not("pinned_at", "is", null);
      if ((count ?? 0) >= 50) throw new Error("This channel has 50 pins. Unpin one first.");
    }
    const { error } = await admin
      .from("chat_messages")
      .update(pinning ? { pinned_at: new Date().toISOString(), pinned_by: viewer.userId } : { pinned_at: null, pinned_by: null })
      .eq("id", row.id);
    if (error) throw new Error(error.message);
    if (pinning) {
      const me = (await getPerson(viewer.userId))?.name ?? "Someone";
      await postSystemLine(row.channel_id, `${me} pinned a message.`);
    }
    return { pinned: pinning };
  });
}

// ---------------------------------------------------------------------------
// Read state and preferences
// ---------------------------------------------------------------------------

/**
 * Move the read cursor up to `upTo` — the newest message the screen actually
 * shows, not "now": a message landing between load and this call was never on
 * screen and stays unread. Never backwards, never past the channel's last
 * message. Always stamps seen_at, which is what keeps a conversation someone
 * is sitting in from ringing their bell. Clears the channel's bells once
 * caught up, so the bell and the badge agree.
 */
export async function markRead(channelId: string, upTo?: string): Promise<ActionResult<{ changed: boolean }>> {
  return runAction({ name: "chat.read" }, async () => {
    const viewer = await viewerNow();
    const found = await getChannelForViewer(channelId, viewer);
    if (!found) throw new Error(NOT_AVAILABLE);
    const { channel } = found;
    // A moderator reading a reported DM is not a party to it.
    if (channel.kind !== "channel" && !isParticipant(channel, viewer)) return { changed: false };
    const admin = createAdminClient();
    const { data: current } = await admin
      .from("chat_reads")
      .select("last_read_at")
      .eq("channel_id", channel.id)
      .eq("user_id", viewer.userId)
      .maybeSingle();
    const was = ((current as any)?.last_read_at as string | undefined) ?? new Date(0).toISOString();
    const last = channel.lastMessageAt;
    let target = upTo && Number.isFinite(Date.parse(upTo)) ? upTo : (last ?? was);
    if (last && laterTimestamp(target, last) !== last) target = last;
    const next = laterTimestamp(was, target);
    const { error } = await admin.from("chat_reads").upsert(
      { channel_id: channel.id, user_id: viewer.userId, last_read_at: next, seen_at: new Date().toISOString() },
      { onConflict: "channel_id,user_id" },
    );
    if (error) throw new Error(error.message);
    let cleared = 0;
    if (!last || laterTimestamp(next, last) === next) cleared = await clearChannelBells(viewer.userId, channel.id);
    return { changed: next !== was || cleared > 0 };
  });
}

/** Mark every channel read: the "Mark all read" in the sidebar. */
export async function markAllRead(): Promise<ActionResult<{ count: number }>> {
  return runAction({ name: "chat.read_all" }, async () => {
    const viewer = await viewerNow();
    const sidebar = await buildSidebar(viewer);
    const items = [...sidebar.channels, ...sidebar.conversations].filter((i) => i.unread > 0 && i.lastMessageAt);
    if (items.length === 0) return { count: 0 };
    const now = new Date().toISOString();
    const { error } = await createAdminClient()
      .from("chat_reads")
      .upsert(
        items.map((i) => ({ channel_id: i.id, user_id: viewer.userId, last_read_at: i.lastMessageAt!, seen_at: now })),
        { onConflict: "channel_id,user_id" },
      );
    if (error) throw new Error(error.message);
    await Promise.all(items.map((i) => clearChannelBells(viewer.userId, i.id)));
    return { count: items.length };
  });
}

export async function setNotify(channelId: string, pref: NotifyPref | null): Promise<ActionResult> {
  return runAction({ name: "chat.notify" }, async () => {
    const viewer = await viewerNow();
    if (pref !== null && pref !== "all" && pref !== "mentions" && pref !== "none") throw new Error("Pick a setting.");
    const found = await getChannelForViewer(channelId, viewer);
    if (!found) throw new Error(NOT_AVAILABLE);
    const { error } = await createAdminClient()
      .from("chat_reads")
      .upsert({ channel_id: found.channel.id, user_id: viewer.userId, notify: pref }, { onConflict: "channel_id,user_id" });
    if (error) throw new Error(error.message);
  });
}

/** Close a DM or group in the sidebar. A newer message brings it back. */
export async function closeConversation(channelId: string): Promise<ActionResult> {
  return runAction({ name: "chat.close" }, async () => {
    const viewer = await viewerNow();
    const found = await getChannelForViewer(channelId, viewer);
    if (!found || found.channel.kind === "channel") throw new Error(NOT_AVAILABLE);
    const { error } = await createAdminClient()
      .from("chat_reads")
      .upsert(
        { channel_id: found.channel.id, user_id: viewer.userId, hidden_at: new Date().toISOString() },
        { onConflict: "channel_id,user_id" },
      );
    if (error) throw new Error(error.message);
  });
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * Check each person may be put in a group with this viewer, and that the
 * whole group (`existing` members plus these) passes the safeguarding rule.
 */
async function assertGroupable(viewer: ChatViewer, ids: string[], existing: string[] = [viewer.userId]): Promise<ChatPerson[]> {
  const people = await getPeople(ids);
  const out: ChatPerson[] = [];
  for (const id of ids) {
    const person = people.get(id);
    if (!person) throw new Error("Someone you picked isn't available.");
    const allowed = await canStartConversation(viewer, person);
    if (!allowed.ok) throw new Error(`${person.name} isn't available.`);
    // Same answer whichever side blocked: blocks are never announced.
    if (await isBlockedBetween(viewer.userId, id)) throw new Error(`${person.name} isn't available.`);
    out.push(person);
  }
  if (!(await membershipAllowed([...existing, ...ids]))) throw new Error(SAFEGUARD_REASON);
  return out;
}

export async function createGroup(input: { userIds: string[]; name?: string | null }): Promise<ActionResult<{ channelId: string }>> {
  return runAction({ name: "chat.group_create" }, async () => {
    const viewer = await viewerNow();
    const ids = Array.from(new Set((input.userIds ?? []).filter(isUuid))).filter((id) => id !== viewer.userId);
    const verdict = canStartGroup(viewer, ids.length);
    if (!verdict.ok) throw new Error(verdict.reason);
    if (ids.length === 1) {
      // One other person is a DM, not a group.
      const dm = await resolveDm(viewer, ids[0]);
      return { channelId: dm.channelId };
    }
    const name = (input.name ?? "").trim().slice(0, GROUP_NAME_MAX) || null;
    const people = await assertGroupable(viewer, ids);
    await rateLimit("chat-new-conversation", viewer.userId, 10, 3600, "You've started a lot of new conversations in the last hour. Try again later.");
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("chat_channels")
      .insert({ kind: "group", audience: "members", name, created_by: viewer.userId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const channelId = (data as { id: string }).id;
    const { error: memErr } = await admin
      .from("chat_members")
      .insert([viewer.userId, ...ids].map((uid) => ({ channel_id: channelId, user_id: uid, added_by: viewer.userId })));
    if (memErr) throw new Error(memErr.message);
    const me = (await getPerson(viewer.userId))?.name ?? "Someone";
    await postSystemLine(channelId, `${me} started a group with ${people.map((p) => p.name).join(", ")}.`);
    return { channelId };
  });
}

export async function addToGroup(channelId: string, userIds: string[]): Promise<ActionResult> {
  return runAction({ name: "chat.group_add" }, async () => {
    const viewer = await viewerNow();
    const found = await getChannelForViewer(channelId, viewer);
    if (!found || found.channel.kind !== "group" || !isParticipant(found.channel, viewer)) throw new Error(NOT_AVAILABLE);
    const current = (await listMembers([channelId])).get(channelId) ?? [];
    const ids = Array.from(new Set(userIds.filter(isUuid))).filter((id) => !current.includes(id));
    if (ids.length === 0) return;
    if (current.length + ids.length > GROUP_MAX_MEMBERS) {
      throw new Error(`A group holds up to ${GROUP_MAX_MEMBERS} people.`);
    }
    const people = await assertGroupable(viewer, ids, current);
    const { error } = await createAdminClient()
      .from("chat_members")
      .upsert(ids.map((uid) => ({ channel_id: channelId, user_id: uid, added_by: viewer.userId })), {
        onConflict: "channel_id,user_id",
        ignoreDuplicates: true,
      });
    if (error) throw new Error(error.message);
    const me = (await getPerson(viewer.userId))?.name ?? "Someone";
    await postSystemLine(channelId, `${me} added ${people.map((p) => p.name).join(", ")}.`);
  });
}

export async function leaveGroup(channelId: string): Promise<ActionResult> {
  return runAction({ name: "chat.group_leave" }, async () => {
    const viewer = await viewerNow();
    const found = await getChannelForViewer(channelId, viewer);
    if (!found || found.channel.kind !== "group" || !isParticipant(found.channel, viewer)) throw new Error(NOT_AVAILABLE);
    const admin = createAdminClient();
    const { error } = await admin.from("chat_members").delete().eq("channel_id", channelId).eq("user_id", viewer.userId);
    if (error) throw new Error(error.message);
    const rest = (await listMembers([channelId])).get(channelId) ?? [];
    const { count: reports } = await admin
      .from("chat_reports")
      .select("id", { count: "exact", head: true })
      .eq("channel_id", channelId);
    if (rest.length === 0 && (reports ?? 0) === 0) {
      // Nobody left to read it, and nothing for the team to review.
      await admin.from("chat_channels").delete().eq("id", channelId);
      return;
    }
    const me = (await getPerson(viewer.userId))?.name ?? "Someone";
    await postSystemLine(channelId, `${me} left the group.`);
  });
}

export async function renameGroup(channelId: string, rawName: string): Promise<ActionResult> {
  return runAction({ name: "chat.group_rename" }, async () => {
    const viewer = await viewerNow();
    const found = await getChannelForViewer(channelId, viewer);
    if (!found || found.channel.kind !== "group" || !isParticipant(found.channel, viewer)) throw new Error(NOT_AVAILABLE);
    const name = String(rawName ?? "").trim().slice(0, GROUP_NAME_MAX) || null;
    if (name === found.channel.name) return;
    const { error } = await createAdminClient().from("chat_channels").update({ name }).eq("id", channelId);
    if (error) throw new Error(error.message);
    const me = (await getPerson(viewer.userId))?.name ?? "Someone";
    await postSystemLine(channelId, name ? `${me} renamed the group to ${name}.` : `${me} removed the group name.`);
  });
}

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

/**
 * Block someone. In a DM neither of you can send afterwards (both keep the
 * history); in channels and groups their messages collapse for you. Never
 * tells them — silence is the point.
 */
export async function blockPerson(userId: string): Promise<ActionResult> {
  return runAction({ name: "chat.block" }, async () => {
    const actor = await requireActor();
    if (!isUuid(userId)) throw new Error("That person isn't available.");
    if (userId === actor.userId) throw new Error("You can't block yourself.");
    if (!(await getPerson(userId))) throw new Error("That person isn't available.");
    const { error } = await createAdminClient()
      .from("chat_blocks")
      .upsert({ blocker_id: actor.userId, blocked_id: userId }, { onConflict: "blocker_id,blocked_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  });
}

export async function unblockPerson(userId: string): Promise<ActionResult> {
  return runAction({ name: "chat.unblock" }, async () => {
    const actor = await requireActor();
    if (!isUuid(userId)) throw new Error("That person isn't available.");
    const { error } = await createAdminClient()
      .from("chat_blocks")
      .delete()
      .eq("blocker_id", actor.userId)
      .eq("blocked_id", userId);
    if (error) throw new Error(error.message);
  });
}

// ---------------------------------------------------------------------------
// Reporting — the one thing that opens a DM or group to the team
// ---------------------------------------------------------------------------

async function fileReport(
  viewer: ChatViewer,
  channel: ChannelRow,
  messageId: string | null,
  rawReason: string,
): Promise<void> {
  const reason = String(rawReason ?? "").trim();
  if (!reason) throw new Error("Tell us what's wrong so we can act on it.");
  if (reason.length > REPORT_REASON_MAX) throw new Error("That's too long — a sentence or two is plenty.");
  await rateLimit("chat-report", viewer.userId, 10, 3600, "You've filed several reports just now. Try again later.");
  const admin = createAdminClient();
  const { count: prior } = await admin
    .from("chat_reports")
    .select("id", { count: "exact", head: true })
    .eq("channel_id", channel.id)
    .eq("status", "open");
  const { data, error } = await admin
    .from("chat_reports")
    .insert({ channel_id: channel.id, message_id: messageId, reporter_id: viewer.userId, reason })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const reportId = (data as { id: string }).id;
  // Pointed at the report, without the reason: the audit log is readable with
  // audit.view, which doesn't imply chat.manage.
  await logAudit({ action: "chat.report", targetType: "chat_report", targetId: reportId, payload: { length: reason.length } });
  // Never a member of a reported DM or group: a moderator who is the person
  // being reported must not be the one told about it.
  const members = channel.kind === "channel" ? [] : ((await listMembers([channel.id])).get(channel.id) ?? []);
  const moderators = (await listModeratorIds()).filter((id) => !members.includes(id) && id !== viewer.userId);
  if (moderators.length > 0) {
    await notifyMany(
      moderators.map((id) => ({
        userId: id,
        type: "chat_reported",
        title: (prior ?? 0) > 0 ? "Another report on a reported conversation" : "Someone reported a chat message",
        link: `/admin/chat/reports/${reportId}`,
      })),
    );
  }
}

/** Report one message. In a DM or group, this also hands the whole conversation to the team. */
export async function reportMessage(input: { messageId: string; reason: string }): Promise<ActionResult> {
  return runAction({ name: "chat.report_message" }, async () => {
    const viewer = await viewerNow();
    const row = await getMessageRow(input.messageId);
    if (!row) throw new Error("That message is gone.");
    const found = await getChannelForViewer(row.channel_id, viewer);
    if (!found) throw new Error(NOT_AVAILABLE);
    if (found.channel.kind !== "channel" && !isParticipant(found.channel, viewer)) throw new Error(NOT_AVAILABLE);
    await fileReport(viewer, found.channel, row.id, input.reason);
  });
}

/** Report a whole DM or group. */
export async function reportConversation(input: { channelId: string; reason: string }): Promise<ActionResult> {
  return runAction({ name: "chat.report_conversation" }, async () => {
    const viewer = await viewerNow();
    const found = await getChannelForViewer(input.channelId, viewer);
    if (!found || !isParticipant(found.channel, viewer)) throw new Error(NOT_AVAILABLE);
    await fileReport(viewer, found.channel, null, input.reason);
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export async function mintUploads(
  channelId: string,
  files: { name: string; size: number; type: string }[],
): Promise<ActionResult<{ uploads: MintedChatUpload[] }>> {
  return runAction({ name: "chat.mint" }, async () => {
    const viewer = await viewerNow();
    const found = await getChannelForViewer(channelId, viewer);
    if (!found) throw new Error(NOT_AVAILABLE);
    await assertCanPost(viewer, found.channel, found.reported);
    await rateLimit("chat-upload", viewer.userId, 40, 3600, "That's a lot of uploads in an hour. Try again later.");
    const minted = await mintChatUploads(found.channel.id, viewer.userId, files);
    if (!minted.ok) throw new Error(minted.error);
    return { uploads: minted.uploads };
  });
}

/**
 * Start a DM so a file can be attached to it (a draft has no channel to
 * upload into yet). Same checks as sending the first message.
 */
export async function openDm(toUserId: string): Promise<ActionResult<{ channelId: string }>> {
  return runAction({ name: "chat.open_dm" }, async () => {
    const viewer = await viewerNow();
    const { channelId } = await resolveDm(viewer, toUserId);
    return { channelId };
  });
}
