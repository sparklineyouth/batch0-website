"use server";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/server-guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { notifyMany } from "@/lib/notifications";
import { runAction, type ActionResult } from "@/lib/action-result";
import { logAudit, logAuditMany } from "@/lib/audit";
import { env } from "@/lib/env";
import {
  asUuid,
  canDeleteMessage,
  canEditMessage,
  canMentionEveryone,
  canPin,
  canPost,
  canStartGroup,
  dmKey,
  FINE_REASON,
  GROUP_MAX_MEMBERS,
  GROUP_NAME_MAX,
  isAllowedReaction,
  isParticipant,
  laterTimestamp,
  MESSAGE_MAX,
  MUTED_REASON,
  otherInDmKey,
  REPORT_REASON_MAX,
  reportPartyIds,
  reportRouting,
  SAFEGUARD_REASON,
  slowModeWait,
  type ChatViewer,
  type NotifyPref,
  type ReactionMap,
  type ReportOutcome,
} from "@/lib/chat-access";
import { mentionedIds, mentionsEveryone } from "@/lib/chat-format";
import { CHAT_MAX_FILES } from "@/lib/chat-files-rules";
import {
  buildSidebar,
  canReach,
  canStartConversation,
  filterReaders,
  findDm,
  getChannelForViewer,
  getChatViewer,
  getMessageRow,
  getMessages,
  getPeople,
  getPerson,
  isBlockedBetween,
  lastSentAt,
  listBlockedPeople,
  listChannelReportParties,
  listChannelSenderIds,
  listDeletedForReport,
  listMembers,
  listModeratorIds,
  countChannelReports,
  membershipAllowed,
  openChannelFor,
  searchChannelPeople as searchChannelPeopleIn,
  searchDirectory,
  searchMessages as searchMessagesIn,
  type ChannelRow,
  type ChatMessage,
  type ChatPerson,
  type DeletedMessageStub,
  type SidebarData,
} from "@/lib/chat";
import { findSentMessage, insertMessageOnce, type SentRow } from "@/lib/chat-send";
import { buildChannelPayload, peopleIn, personalLocks, type ChannelPayload, type ChannelTarget } from "@/lib/chat-payload";
import { chatLink, clearChannelBells, clearChannelBellsMany, notifyNewMessage } from "@/lib/chat-notify";
import { mintChatUploads, removeChannelFiles, verifyChatUploads, type MintedChatUpload } from "@/lib/chat-files";
import {
  currentReader,
  readAttention,
  readMembers,
  readMessages,
  readMessagesById,
  readPins,
  readSidebar,
  type MessagesByIdPayload,
  type MessagesPayload,
  type Reader,
} from "@/app/chat/api/reads";

/**
 * Server actions for batch0 Chat (migration 0101).
 *
 * Mutations live here, and return an ActionResult, because every interesting
 * failure in a chat is one the person needs to read: blocked, archived, slow
 * mode, too long. The actor and every rule are re-derived on every call; a
 * page guard protects none of this.
 *
 * The reads the client polls are GET routes (app/chat/api/*): Next runs
 * server actions one at a time, so a poll made as an action would hold up the
 * send typed right after it. The read actions below share those routes'
 * implementation (app/chat/api/reads.ts) and stay for anything still calling
 * them; they throw on failure.
 *
 * Reads take the signed-in person from the locally verified JWT; writes from
 * the auth server (requireActor), so a deleted account stops writing at once.
 *
 * Nothing here calls revalidatePath: /chat is force-dynamic and the client
 * owns its panes, and a revalidation would re-render the whole route behind
 * every message.
 */

/** The viewer for a WRITE: verified against the auth server, then the whole picture. */
async function viewerNow(): Promise<ChatViewer> {
  const actor = await requireActor();
  return getChatViewer(actor.userId, actor.caps);
}

/** The person for a READ (lib/auth.ts getViewer: the JWT checked locally). */
async function readerNow(): Promise<Reader> {
  const reader = await currentReader();
  if (!reader) throw new Error("Not signed in");
  return reader;
}

const NOT_AVAILABLE = "That channel isn't available.";

/**
 * A message body, normalized: CRLF to LF, leading blank lines and trailing
 * whitespace gone. Length is checked before any of that touches it, and
 * nothing here backtracks — a body is whatever the caller sent, a megabyte
 * of spaces included.
 */
function cleanBody(raw: unknown, { allowEmpty = false } = {}): string {
  if (typeof raw === "string" && raw.length > MESSAGE_MAX * 2) {
    throw new Error(`That message is too long (max ${MESSAGE_MAX.toLocaleString()} characters).`);
  }
  const b = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").replace(/^\n+/, "").trimEnd() : "";
  if (!b && !allowEmpty) throw new Error("Write a message first.");
  if (b.length > MESSAGE_MAX) throw new Error(`That message is too long (max ${MESSAGE_MAX.toLocaleString()} characters).`);
  return b;
}

async function rateLimit(kind: string, userId: string, limit: number, windowSeconds: number, message: string) {
  const rl = await checkRateLimit({ kind, identifier: userId, limit, windowSeconds });
  if (!rl.ok) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Reads (the GET routes in app/chat/api/ are what the client polls)
// ---------------------------------------------------------------------------

export async function fetchSidebar(): Promise<SidebarData> {
  return readSidebar(await readerNow());
}

/** The nav badge's count, and whose it is — the badge listens for that person's chat bells. */
export async function fetchAttention(): Promise<{ n: number; userId: string | null }> {
  return readAttention(await currentReader().catch(() => null));
}

export async function fetchChannel(target: ChannelTarget): Promise<ChannelPayload> {
  const r = await readerNow();
  const payload = await buildChannelPayload(await getChatViewer(r.userId, r.caps), target);
  if (!payload) throw new Error(NOT_AVAILABLE);
  return payload;
}

/**
 * Older messages for infinite scroll (before the oldest loaded message: its
 * createdAt and id), newer ones after a jump, or a resync of the newest page.
 */
export async function fetchMessages(
  channelId: string,
  opts: { before?: string; beforeId?: string; around?: string } = {},
): Promise<MessagesPayload> {
  const page = await readMessages(await readerNow(), channelId, opts);
  if (!page) throw new Error(NOT_AVAILABLE);
  return page;
}

/** Messages by id — the realtime path hands the client ids it then hydrates. */
export async function fetchMessagesById(channelId: string, ids: string[]): Promise<MessagesByIdPayload> {
  const found = await readMessagesById(await readerNow(), channelId, Array.isArray(ids) ? ids : []);
  if (!found) throw new Error(NOT_AVAILABLE);
  return found;
}

export async function fetchMembers(channelId: string): Promise<ChatPerson[]> {
  const people = await readMembers(await readerNow(), channelId);
  if (!people) throw new Error(NOT_AVAILABLE);
  return people;
}

export async function fetchPins(channelId: string): Promise<MessagesByIdPayload> {
  const pins = await readPins(await readerNow(), channelId);
  if (!pins) throw new Error(NOT_AVAILABLE);
  return pins;
}

export async function searchMessages(
  query: string,
  channelId?: string | null,
): Promise<{ messages: ChatMessage[]; people: Record<string, ChatPerson> }> {
  const r = await readerNow();
  await rateLimit("chat-search", r.userId, 30, 60, "Too many searches in a row. Give it a second.");
  // "This conversation" with an id that isn't one finds nothing, never everything.
  const scope = channelId ? asUuid(channelId) : null;
  if (channelId && !scope) return { messages: [], people: {} };
  const viewer = await getChatViewer(r.userId, r.caps);
  const messages = await searchMessagesIn(viewer, String(query ?? "").slice(0, 200), scope);
  return { messages, people: Object.fromEntries(await getPeople(peopleIn(messages))) };
}

/**
 * Who a group being put together already holds, for the directory: an
 * existing group's members (`channelId`, one the viewer is in) and the people
 * picked so far (`withIds`). Without it the search is for a DM.
 */
export type DirectoryGroup = { channelId?: string | null; withIds?: string[] };

export async function searchPeople(query: string, group: DirectoryGroup | null = null): Promise<ChatPerson[]> {
  const r = await readerNow();
  const viewer = await getChatViewer(r.userId, r.caps);
  let members: string[] | null = null;
  if (group && typeof group === "object") {
    // Picks are only ever the viewer's own claim about the group: the rule
    // is asked about the people they name, by their real roles, and
    // createGroup / addToGroup ask it again before anything is written.
    const picked = Array.from(
      new Set((Array.isArray(group.withIds) ? group.withIds : []).map(asUuid).filter((id): id is string => !!id)),
    ).slice(0, GROUP_MAX_MEMBERS);
    members = picked;
    if (group.channelId) {
      const found = await getChannelForViewer(String(group.channelId), viewer);
      if (!found || found.channel.kind !== "group" || !isParticipant(found.channel, viewer)) throw new Error(NOT_AVAILABLE);
      members = [...((await listMembers([found.channel.id])).get(found.channel.id) ?? []), ...picked];
    }
  }
  return searchDirectory(String(query ?? "").slice(0, 100), viewer, 20, members);
}

/**
 * @-mention autocomplete as you type, for channels too big for the preloaded
 * member list: up to eight people whose name matches and who can read this
 * channel. Only someone who can read it may ask.
 */
export async function searchChannelPeople(channelId: string, q: string): Promise<ChatPerson[]> {
  const r = await readerNow();
  const query = String(q ?? "").trim().slice(0, 60);
  if (!query) return [];
  await rateLimit("chat-mention-search", r.userId, 60, 60, "Too many lookups in a row. Give it a second.");
  const found = await openChannelFor(String(channelId ?? ""), r.userId, r.caps);
  if (!found) throw new Error(NOT_AVAILABLE);
  return searchChannelPeopleIn(found.channel, query);
}

export async function fetchBlockedPeople(): Promise<ChatPerson[]> {
  return listBlockedPeople((await readerNow()).userId);
}

/**
 * "Report a deleted message": a text channel's recently deleted messages as
 * stubs (who sent it and when, never what it said), so something posted and
 * then deleted can still be reported. The reporter gets back nothing it said;
 * the report page shows its earlier versions to moderators the report leaves
 * out (lib/chat.ts listDeletedForReport, reportMessage below).
 */
export async function fetchDeletedMessages(
  channelId: string,
): Promise<{ messages: DeletedMessageStub[]; people: Record<string, ChatPerson> }> {
  const r = await readerNow();
  await rateLimit("chat-deleted-list", r.userId, 20, 60, "Too many lookups in a row. Give it a second.");
  const found = await openChannelFor(String(channelId ?? ""), r.userId, r.caps);
  if (!found) throw new Error(NOT_AVAILABLE);
  const messages = await listDeletedForReport(found.channel, r.userId);
  return { messages, people: Object.fromEntries(await getPeople(messages.map((m) => m.senderId))) };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * The DM with a person, created on the first message. Every check runs BEFORE
 * the row exists: creating it first would let a blocked sender push empty
 * conversations into the inbox of the person who blocked them.
 */
async function resolveDm(viewer: ChatViewer, rawTo: string): Promise<{ channelId: string; created: boolean }> {
  const toUserId = asUuid(rawTo);
  if (!toUserId || toUserId === viewer.userId) throw new Error("Pick someone to message.");
  const key = dmKey(viewer.userId, toUserId);
  const existing = await findDm(key);
  if (existing) return { channelId: await healDmMembers(existing.id, viewer.userId, toUserId), created: false };
  const person = await getPerson(toUserId);
  if (!person) throw new Error("That person isn't available.");
  const allowed = await canStartConversation(viewer, person);
  if (!allowed.ok) throw new Error(allowed.reason);
  if (await isBlockedBetween(viewer.userId, toUserId)) throw new Error("You can't send messages to this person.");
  // The mute and fine locks, before the row exists: otherwise a locked
  // account could still push empty conversations into other people's inboxes.
  await assertNotLocked(viewer, person);
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
    if (again) return { channelId: await healDmMembers(again.id, viewer.userId, toUserId), created: false };
    throw new Error(error.message);
  }
  const channelId = await healDmMembers((data as { id: string }).id, viewer.userId, toUserId);
  return { channelId, created: true };
}

/**
 * Make sure both people are members of their DM. Idempotent, so it also
 * repairs a DM whose member rows didn't land (a failed second write, or the
 * loser of a simultaneous first send) instead of locking both people out of
 * it for good.
 */
async function healDmMembers(channelId: string, me: string, other: string): Promise<string> {
  const { error } = await createAdminClient()
    .from("chat_members")
    .upsert(
      [
        { channel_id: channelId, user_id: me, added_by: me },
        { channel_id: channelId, user_id: other, added_by: me },
      ],
      { onConflict: "channel_id,user_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(error.message);
  return channelId;
}

/**
 * A chat mute or a pending fine locks an account out of everything that
 * shows others something new. One door stays open for both: a DM with the
 * team, to ask about it. (Middleware used to gate /messages; /chat stays
 * reachable so the door works, and every action that writes checks this.)
 */
async function assertNotLocked(viewer: ChatViewer, dmWith: ChatPerson | null = null): Promise<void> {
  const locks = await personalLocks(viewer, dmWith);
  if (locks.muted) throw new Error(MUTED_REASON);
  if (locks.fined) throw new Error(FINE_REASON);
}

/**
 * The freeze rules — archived, read-only, moderator view, a DM block, a
 * departed account, the safeguarding rule, a mute, a pending fine — with no
 * slow mode. Every action that changes what others see in a conversation runs
 * this: sending, but also editing, reacting, pinning and renaming, or a
 * frozen conversation would keep carrying new words through an edit.
 */
async function postVerdict(viewer: ChatViewer, channel: ChannelRow, reported: boolean): Promise<{ otherId: string | null }> {
  const participant = isParticipant(channel, viewer);
  let blocked = false;
  let otherPresent = true;
  let otherId: string | null = null;
  let other: ChatPerson | null = null;
  const members = channel.kind !== "channel" && participant ? ((await listMembers([channel.id])).get(channel.id) ?? []) : [];
  if (channel.kind === "dm" && participant) {
    otherId = otherInDmKey(channel.dmKey, viewer.userId);
    otherPresent = !!otherId && members.includes(otherId);
    [blocked, other] = await Promise.all([
      otherId ? isBlockedBetween(viewer.userId, otherId) : Promise.resolve(false),
      otherId ? getPerson(otherId) : Promise.resolve(null),
    ]);
  }
  const [safeguarded, locks] = await Promise.all([
    channel.kind !== "channel" && participant ? membershipAllowed(members).then((ok) => !ok) : Promise.resolve(false),
    personalLocks(viewer, other),
  ]);
  const verdict = canPost(channel, viewer, { reported, blocked, otherPresent, safeguarded, ...locks });
  if (!verdict.ok) throw new Error(verdict.reason);
  return { otherId };
}

/** Everything that decides whether this viewer may post here right now. */
async function assertCanPost(viewer: ChatViewer, channel: ChannelRow, reported: boolean): Promise<void> {
  await postVerdict(viewer, channel, reported);
  const wait = slowModeWait(channel, viewer, await lastSentAt(channel.id, viewer.userId), Date.now());
  if (wait > 0) throw new Error(`Slow mode is on. You can post again in ${wait}s.`);
}

/**
 * Who a message pings: the people it @mentions who can read the channel, and
 * — a reply being an answer to someone — the sender of the message it
 * replies to, while they can still read it and neither side has blocked the
 * other. Discord pings on reply too; a question asked in #help shouldn't go
 * unanswered because nobody typed the asker's name.
 */
async function pingsFor(
  channel: ChannelRow,
  viewer: ChatViewer,
  body: string,
  replyTo: { senderId: string | null; kind: string } | null,
): Promise<string[]> {
  const author = replyTo && replyTo.kind === "message" && replyTo.senderId !== viewer.userId ? replyTo.senderId : null;
  const readers = await filterReaders(channel, [...(author ? [author] : []), ...mentionedIds(body)]);
  if (author && readers.includes(author) && !mentionedIds(body).includes(author)) {
    if (await isBlockedBetween(viewer.userId, author)) return readers.filter((id) => id !== author);
  }
  return readers;
}

export type SendInput = {
  channelId?: string;
  toUserId?: string;
  body: string;
  replyToId?: string | null;
  attachments?: { path: string; name: string }[];
  /**
   * The composer's id for this message (a uuid), made once when it was
   * written and sent again by every Retry. A resend of a message that went
   * through gets the original back (0104, lib/chat-send.ts).
   */
  clientId?: string | null;
};

/**
 * A resend of a message that already went in: hand back that message, as
 * the first send would have. Only to where it was sent — the same channel,
 * or the DM with the same person a draft's first message created — and only
 * while the sender can still read it there. Nothing is posted, belled or
 * marked read again.
 */
async function replaySent(viewer: ChatViewer, sent: SentRow, input: SendInput): Promise<{ channelId: string; message: ChatMessage }> {
  const found = await getChannelForViewer(sent.channel_id, viewer);
  if (!found) throw new Error(NOT_AVAILABLE);
  const channel = found.channel;
  const wanted = asUuid(input.channelId);
  const to = asUuid(input.toUserId);
  const same = wanted
    ? wanted === channel.id
    : !!to && to !== viewer.userId && channel.kind === "dm" && channel.dmKey === dmKey(viewer.userId, to);
  if (!same) throw new Error("That message was already sent in another conversation.");
  if (sent.deleted_at) throw new Error("That message was sent, and has been deleted since.");
  const [message] = await getMessages([sent.id]);
  if (!message) throw new Error("Sent, but couldn't load it back. Refresh to see it.");
  return { channelId: channel.id, message };
}

export async function sendMessage(input: SendInput): Promise<ActionResult<{ channelId: string; message: ChatMessage }>> {
  return runAction({ name: "chat.send" }, async () => {
    const viewer = await viewerNow();
    const clientId = asUuid(input.clientId);
    // A Retry of a message whose answer was lost on the way back: it went in,
    // so it's that message, not a new one. Asked before every check the first
    // send itself trips — slow mode's clock, the rate limit — or the retry of
    // a message that's already there would be refused, and still show as failed.
    if (clientId) {
      const sent = await findSentMessage(viewer.userId, clientId);
      if (sent) return replaySent(viewer, sent, input);
    }
    const hasFiles = Array.isArray(input.attachments) && input.attachments.length > 0;
    const body = cleanBody(input.body, { allowEmpty: hasFiles });
    // Before anything is created: a first message the limit refuses must not
    // leave an empty DM in the other person's sidebar.
    await rateLimit("chat-message", viewer.userId, 30, 60, "Slow down — too many messages in a row.");

    let channelId = asUuid(input.channelId);
    if (!channelId && input.toUserId) {
      // Files are staged against an existing channel (openDm makes it), so a
      // first message that would create the DM can't carry any.
      const to = asUuid(input.toUserId);
      if (hasFiles && (!to || to === viewer.userId || !(await findDm(dmKey(viewer.userId, to))))) {
        throw new Error("Attach the files again: the conversation they were for isn't there.");
      }
      // The block, safeguarding, mute and fine checks run inside resolveDm;
      // the new-conversation rate limit only when a row is actually created.
      const resolved = await resolveDm(viewer, input.toUserId);
      channelId = resolved.channelId;
      // resolveDm made sure the viewer is a member (created, raced or healed),
      // but the viewer was resolved before that.
      if (!viewer.memberOf.includes(channelId)) viewer.memberOf = [...viewer.memberOf, channelId];
    }
    if (!channelId) throw new Error("Pick a channel or a person first.");

    const found = await getChannelForViewer(channelId, viewer);
    if (!found) throw new Error(NOT_AVAILABLE);
    const { channel, reported } = found;
    await assertCanPost(viewer, channel, reported);

    const files = await verifyChatUploads(input.attachments, channel.id, viewer.userId);
    if (!files.ok) throw new Error(files.error);

    let replyTo: { id: string; senderId: string | null; kind: string } | null = null;
    if (input.replyToId) {
      const target = await getMessageRow(input.replyToId);
      if (!target || target.channel_id !== channel.id || target.deleted_at) {
        throw new Error("The message you're replying to is gone.");
      }
      replyTo = { id: target.id, senderId: target.sender_id ?? null, kind: target.kind };
    }

    const mentions = await pingsFor(channel, viewer, body, replyTo);
    const everyone = canMentionEveryone(channel, viewer) && mentionsEveryone(body);

    const written = await insertMessageOnce(
      {
        channel_id: channel.id,
        sender_id: viewer.userId,
        body,
        reply_to_id: replyTo?.id ?? null,
        mentions,
        mention_everyone: everyone,
        attachments: files.attachments,
      },
      clientId,
    );
    // The same message, sent twice at once (a Retry racing a slow first
    // send): the other request's row is it, and that request does the rest.
    if ("duplicate" in written) return replaySent(viewer, written.duplicate, input);
    const row = written.inserted;
    const admin = createAdminClient();

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
    await postVerdict(viewer, found.channel, found.reported);
    const hasFiles = Array.isArray(row.attachments) && row.attachments.length > 0;
    const body = cleanBody(rawBody, { allowEmpty: hasFiles });
    if (body === row.body) {
      const [same] = await getMessages([row.id]);
      return { message: same };
    }
    await rateLimit("chat-edit", viewer.userId, 30, 60, "Too many edits in a row. Give it a second.");
    // Edits don't ring bells (Discord doesn't either), but the mention list
    // follows the text so the unread badge stays honest — the reply's
    // author included, as on send.
    const replied = row.reply_to_id ? await getMessageRow(row.reply_to_id) : null;
    const mentions = await pingsFor(
      found.channel,
      viewer,
      body,
      replied && !replied.deleted_at ? { senderId: replied.sender_id ?? null, kind: replied.kind } : null,
    );
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
    if (found.channel.kind !== "channel") {
      // In a DM or group a reaction is a message; a frozen one takes none.
      await postVerdict(viewer, found.channel, found.reported);
    } else {
      // In a text channel anyone who reads it may react — #announcements
      // included, which they can't post in — unless muted or fined.
      await assertNotLocked(viewer);
    }
    await rateLimit("chat-react", viewer.userId, 60, 60, "Easy on the reactions — try again in a moment.");
    const admin = createAdminClient();
    const key = { message_id: row.id, user_id: viewer.userId, emoji };
    const { data: existing, error: readErr } = await admin.from("chat_reactions").select("emoji").match(key).maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (existing) {
      const { error } = await admin.from("chat_reactions").delete().match(key);
      if (error) throw new Error(error.message);
    } else {
      const { count, error: countErr } = await admin
        .from("chat_reactions")
        .select("emoji", { count: "exact", head: true })
        .eq("message_id", row.id);
      if (countErr) throw new Error(countErr.message);
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
    if (found.channel.kind !== "channel") await postVerdict(viewer, found.channel, found.reported);
    else if (found.channel.archivedAt) throw new Error("This channel is archived. It's read-only now.");
    await rateLimit("chat-pin", viewer.userId, 20, 600, "That's a lot of pinning. Try again in a few minutes.");
    const admin = createAdminClient();
    const pinning = !row.pinned_at;
    if (pinning) {
      const { count, error: countErr } = await admin
        .from("chat_messages")
        .select("id", { count: "exact", head: true })
        .eq("channel_id", row.channel_id)
        .not("pinned_at", "is", null);
      if (countErr) throw new Error(countErr.message);
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
 * message: a failed read of the current cursor throws rather than reading as
 * "never read", which would let the write rewind it. Always stamps seen_at,
 * which is what keeps a conversation someone is sitting in from ringing their
 * bell. Clears the channel's bells once caught up, so the bell and the badge
 * agree. Runs on every new message in an open channel, so it takes the cheap
 * read-path viewer for this one channel: it only ever writes the caller's own
 * read state.
 */
export async function markRead(channelId: string, upTo?: string): Promise<ActionResult<{ changed: boolean }>> {
  return runAction({ name: "chat.read" }, async () => {
    const r = await readerNow();
    const found = await openChannelFor(String(channelId ?? ""), r.userId, r.caps);
    if (!found) throw new Error(NOT_AVAILABLE);
    const { channel, viewer } = found;
    // A moderator reading a reported DM is not a party to it.
    if (channel.kind !== "channel" && !isParticipant(channel, viewer)) return { changed: false };
    const admin = createAdminClient();
    const { data: current, error: readErr } = await admin
      .from("chat_reads")
      .select("last_read_at")
      .eq("channel_id", channel.id)
      .eq("user_id", viewer.userId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
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
    await clearChannelBellsMany(viewer.userId, items.map((i) => i.id));
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
 * Check each person may be reached by this viewer (canReach: the directory
 * rule, and blocks), then the safeguarding rule ONCE, on the whole group —
 * `existing` members plus these. Pairwise it would refuse a student adding
 * a mentor to a group a staff member is in, which the rule allows.
 */
async function assertGroupable(viewer: ChatViewer, ids: string[], existing: string[] = [viewer.userId]): Promise<ChatPerson[]> {
  const people = await getPeople(ids);
  const out: ChatPerson[] = [];
  for (const id of ids) {
    const person = people.get(id);
    if (!person) throw new Error("Someone you picked isn't available.");
    const reach = await canReach(viewer, person);
    if (!reach.ok) throw new Error(`${person.name} isn't available.`);
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
    const ids = Array.from(new Set((input.userIds ?? []).map(asUuid).filter((id): id is string => !!id))).filter(
      (id) => id !== viewer.userId,
    );
    const verdict = canStartGroup(viewer, ids.length);
    if (!verdict.ok) throw new Error(verdict.reason);
    if (ids.length === 1) {
      // One other person is a DM, not a group.
      const dm = await resolveDm(viewer, ids[0]);
      return { channelId: dm.channelId };
    }
    const name = (input.name ?? "").trim().slice(0, GROUP_NAME_MAX) || null;
    await assertNotLocked(viewer);
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
    if (memErr) {
      // A group nobody is in is unreachable: take it back down.
      await admin.from("chat_channels").delete().eq("id", channelId);
      throw new Error(memErr.message);
    }
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
    const group = found.channel.id;
    await assertNotLocked(viewer);
    await rateLimit("chat-group-admin", viewer.userId, 10, 600, "Too many group changes in a row. Try again in a few minutes.");
    const current = (await listMembers([group])).get(group) ?? [];
    const ids = Array.from(new Set((userIds ?? []).map(asUuid).filter((id): id is string => !!id))).filter(
      (id) => !current.includes(id),
    );
    if (ids.length === 0) return;
    if (current.length + ids.length > GROUP_MAX_MEMBERS) {
      throw new Error(`A group holds up to ${GROUP_MAX_MEMBERS} people.`);
    }
    const people = await assertGroupable(viewer, ids, current);
    // A moderator added to a reported group would become a party to its next
    // report, and a party sees none of the group's reports: adding the
    // moderator and reporting again would bury the first report. They read
    // a reported group through its reports instead.
    const moderators = await listModeratorIds();
    if (ids.some((id) => moderators.includes(id)) && (await countChannelReports(group)) > 0) {
      throw new Error("batch0 staff can't be added to this group.");
    }
    const { error } = await createAdminClient()
      .from("chat_members")
      .upsert(ids.map((uid) => ({ channel_id: group, user_id: uid, added_by: viewer.userId })), {
        onConflict: "channel_id,user_id",
        ignoreDuplicates: true,
      });
    if (error) throw new Error(error.message);
    const me = (await getPerson(viewer.userId))?.name ?? "Someone";
    await postSystemLine(group, `${me} added ${people.map((p) => p.name).join(", ")}.`);
  });
}

export async function leaveGroup(channelId: string): Promise<ActionResult> {
  return runAction({ name: "chat.group_leave" }, async () => {
    const viewer = await viewerNow();
    const found = await getChannelForViewer(channelId, viewer);
    if (!found || found.channel.kind !== "group" || !isParticipant(found.channel, viewer)) throw new Error(NOT_AVAILABLE);
    const group = found.channel.id;
    // Asked before leaving, and an error stops here: a failed count must
    // never read as "no reports" and take a reported group's evidence with it.
    const reports = await countChannelReports(group);
    const admin = createAdminClient();
    const { error } = await admin.from("chat_members").delete().eq("channel_id", group).eq("user_id", viewer.userId);
    if (error) throw new Error(error.message);
    const rest = (await listMembers([group])).get(group) ?? [];
    if (rest.length === 0 && reports === 0) {
      // Nobody left to read it, and nothing for the team to review.
      const { error: delErr } = await admin.from("chat_channels").delete().eq("id", group);
      // A report filed in the meantime keeps the group (0101's foreign key
      // refuses the delete): nobody is left in it, and the team has its record.
      if (delErr) {
        if (delErr.code !== "23503") console.error("[chat] removing an empty group failed", delErr.message);
      } else await removeChannelFiles(group);
      return;
    }
    const me = (await getPerson(viewer.userId))?.name ?? "Someone";
    await postSystemLine(group, `${me} left the group.`);
  });
}

export async function renameGroup(channelId: string, rawName: string): Promise<ActionResult> {
  return runAction({ name: "chat.group_rename" }, async () => {
    const viewer = await viewerNow();
    const found = await getChannelForViewer(channelId, viewer);
    if (!found || found.channel.kind !== "group" || !isParticipant(found.channel, viewer)) throw new Error(NOT_AVAILABLE);
    const name = String(rawName ?? "").trim().slice(0, GROUP_NAME_MAX) || null;
    if (name === found.channel.name) return;
    // A rename posts a line everyone sees, so it obeys the same freeze.
    await postVerdict(viewer, found.channel, found.reported);
    await rateLimit("chat-group-admin", viewer.userId, 10, 600, "Too many group changes in a row. Try again in a few minutes.");
    const { error } = await createAdminClient().from("chat_channels").update({ name }).eq("id", found.channel.id);
    if (error) throw new Error(error.message);
    const me = (await getPerson(viewer.userId))?.name ?? "Someone";
    await postSystemLine(found.channel.id, name ? `${me} renamed the group to ${name}.` : `${me} removed the group name.`);
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
    const id = asUuid(userId);
    if (!id) throw new Error("That person isn't available.");
    if (id === actor.userId) throw new Error("You can't block yourself.");
    if (!(await getPerson(id))) throw new Error("That person isn't available.");
    const { error } = await createAdminClient()
      .from("chat_blocks")
      .upsert({ blocker_id: actor.userId, blocked_id: id }, { onConflict: "blocker_id,blocked_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  });
}

export async function unblockPerson(userId: string): Promise<ActionResult> {
  return runAction({ name: "chat.unblock" }, async () => {
    const actor = await requireActor();
    const id = asUuid(userId);
    if (!id) throw new Error("That person isn't available.");
    const { error } = await createAdminClient()
      .from("chat_blocks")
      .delete()
      .eq("blocker_id", actor.userId)
      .eq("blocked_id", id);
    if (error) throw new Error(error.message);
  });
}

// ---------------------------------------------------------------------------
// Reporting — the one thing that opens a DM or group to the team
// ---------------------------------------------------------------------------

async function fileReport(
  viewer: ChatViewer,
  channel: ChannelRow,
  message: { id: string; senderId: string | null } | null,
  rawReason: string,
): Promise<ReportOutcome> {
  const reason = String(rawReason ?? "").trim();
  if (!reason) throw new Error("Tell us what's wrong so we can act on it.");
  if (reason.length > REPORT_REASON_MAX) throw new Error("That's too long — a sentence or two is plenty.");
  await rateLimit("chat-report", viewer.userId, 10, 3600, "You've filed several reports just now. Try again later.");
  // Everything that can fail runs before the report exists: one that's in
  // the table but told to nobody would sit there unseen.
  const conversation = channel.kind !== "channel";
  const [earlier, members, senders, moderators] = await Promise.all([
    conversation ? listChannelReportParties(channel.id) : Promise.resolve([] as { partyIds: string[] }[]),
    conversation ? listMembers([channel.id]).then((m) => m.get(channel.id) ?? []) : Promise.resolve([] as string[]),
    conversation ? listChannelSenderIds(channel.id) : Promise.resolve([] as string[]),
    listModeratorIds(),
  ]);
  // Who it's about, frozen now (reportPartyIds): a text-channel report's
  // sender; everyone a DM or group has held. A moderator among them never
  // sees it — for a conversation, nor any other report on it, or reads the
  // conversation through them; leaving the group afterwards changes nothing.
  const partyIds = reportPartyIds({
    kind: channel.kind,
    members,
    senders,
    messageSenderId: message?.senderId ?? null,
    earlier,
  });
  const { data, error } = await createAdminClient()
    .from("chat_reports")
    .insert({ channel_id: channel.id, message_id: message?.id ?? null, reporter_id: viewer.userId, reason, party_ids: partyIds })
    .select("id, party_ids")
    .single();
  if (error) throw new Error(error.message);
  const reportId = (data as { id: string }).id;
  // What was stored is what the read rule and the queue will judge by: 0101's
  // chat_reports_freeze_parties trigger adds anyone this list missed (say,
  // someone who joined or posted a moment ago). Bells follow it.
  const stored = (data as { party_ids: string[] | null }).party_ids;
  const parties = Array.isArray(stored) ? stored : partyIds;
  // A system row, pointed at the report: no reporter, no reason. audit.view
  // doesn't imply chat.manage, and a moderator the report is about must not
  // read who filed it, or when they did, off the audit log.
  await logAuditMany(null, [{ action: "chat.report", targetType: "chat_report", targetId: reportId }]);

  const own = { partyIds: parties };
  const routing = reportRouting(channel.kind, moderators, own, [...earlier, own], viewer.userId);
  if (routing.notify.length > 0) {
    await notifyMany(
      routing.notify.map((id) => ({
        userId: id,
        type: "chat_reported",
        title: earlier.length > 0 ? "Another report on a reported conversation" : "Someone reported a chat message",
        link: `/admin/chat/reports/${reportId}`,
      })),
    );
  }
  if (!routing.outside) return { routedTo: "moderators" };
  // Every moderator is part of it. Nothing on the team can carry it safely:
  // a Support concern is readable by every full admin, and every full admin
  // moderates chat, so every one of them is a party here. It stays saved for
  // the first moderator who isn't (the queue shows it to them), and the
  // reporter is pointed outside batch0 (outsideReportAdvice).
  console.warn("[chat] report reached no moderator: every moderator is a party", { reportId });
  await logAuditMany(null, [{ action: "chat.report_unrouted", targetType: "chat_report", targetId: reportId }]);
  return { routedTo: "outside", safeguardingEmail: env.safeguardingEmail };
}

/** Report one message. In a DM or group, this also hands the whole conversation to the team. */
export async function reportMessage(input: { messageId: string; reason: string }): Promise<ActionResult<ReportOutcome>> {
  return runAction({ name: "chat.report_message" }, async () => {
    const viewer = await viewerNow();
    const row = await getMessageRow(input.messageId);
    if (!row) throw new Error("That message is gone.");
    const found = await getChannelForViewer(row.channel_id, viewer);
    if (!found) throw new Error(NOT_AVAILABLE);
    if (found.channel.kind !== "channel" && !isParticipant(found.channel, viewer)) throw new Error(NOT_AVAILABLE);
    return fileReport(viewer, found.channel, { id: row.id, senderId: row.sender_id ?? null }, input.reason);
  });
}

/** Report a whole DM or group. */
export async function reportConversation(input: { channelId: string; reason: string }): Promise<ActionResult<ReportOutcome>> {
  return runAction({ name: "chat.report_conversation" }, async () => {
    const viewer = await viewerNow();
    const found = await getChannelForViewer(input.channelId, viewer);
    if (!found || !isParticipant(found.channel, viewer)) throw new Error(NOT_AVAILABLE);
    return fileReport(viewer, found.channel, null, input.reason);
  });
}

// ---------------------------------------------------------------------------
// Asking the team for help (what Discord's "Flag as Blocker" was)
// ---------------------------------------------------------------------------

const FLAG_NOTE_MAX = 300;

/**
 * Point the team at a message: someone is stuck, or something needs a staff
 * eye that isn't a report. Every chat.manage holder gets a bell that opens
 * the message. Text channels only — staff can read those; in a DM or group
 * the way to bring the team in is a report, which says what it hands over.
 */
export async function flagForTeam(messageId: string, note: string): Promise<ActionResult> {
  return runAction({ name: "chat.flag" }, async () => {
    const viewer = await viewerNow();
    const row = await getMessageRow(messageId);
    if (!row || row.deleted_at) throw new Error("That message is gone.");
    const found = await getChannelForViewer(row.channel_id, viewer);
    if (!found) throw new Error(NOT_AVAILABLE);
    if (found.channel.kind !== "channel") {
      throw new Error("In a private conversation, use Report to bring the batch0 team in.");
    }
    if (row.kind !== "message") throw new Error("Pick a message to ask about.");
    const text = String(note ?? "").replace(/\s+/g, " ").trim().slice(0, FLAG_NOTE_MAX);
    await rateLimit("chat-flag", viewer.userId, 5, 3600, "You've asked the team a few times just now. They'll see it — try again later.");
    const moderators = (await listModeratorIds()).filter((id) => id !== viewer.userId);
    if (moderators.length === 0) return;
    const me = (await getPerson(viewer.userId))?.name ?? "Someone";
    await notifyMany(
      moderators.map((id) => ({
        userId: id,
        type: "chat_flagged",
        // The title names who and where, never the message's words; the
        // flagger's own note rides in the body (only its recipient reads it).
        title: `${me} asked the team for help in #${found.channel.name ?? "a channel"}`,
        body: text || null,
        link: `${chatLink(found.channel.id)}&m=${row.id}`,
      })),
    );
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
    // The limit counts files, not calls: one call stages up to five.
    const count = Math.min(Array.isArray(files) ? files.length : 0, CHAT_MAX_FILES);
    for (let i = 0; i < Math.max(count, 1); i++) {
      await rateLimit("chat-upload", viewer.userId, 40, 3600, "That's a lot of uploads in an hour. Try again later.");
    }
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
