import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { MUTED_REASON } from "@/lib/chat-access";
import { splitPostBody } from "@/lib/chat-post-split";
import { getPerson, isMuted } from "@/lib/chat";
import { notifyNewMessage } from "@/lib/chat-notify";

/**
 * Posting into a channel from somewhere other than the chat UI: an
 * announcement cross-posted into #announcements, a system line in a team
 * channel. The one door for that, so every caller gets the same rules —
 * the body cap, a chat mute, the "not set up yet" fallback before migration
 * 0101, and the same bells a person's message would ring.
 *
 * Never throws. A post that can't happen is reported, not raised: none of the
 * callers should fail their own job (sending the announcement email, say)
 * because the chat copy didn't land.
 */

export type PostTarget = { systemKey: string } | { channelId: string };

export type PostResult =
  /** messageId is the first message; a body longer than one message is several. */
  | { ok: true; messageId: string; messageIds: string[]; channelId: string }
  | { ok: false; reason: string };

export async function postToChannel(
  target: PostTarget,
  input: {
    /** Null posts as batch0 itself (a system line). */
    senderId: string | null;
    /**
     * Any length. Longer than one message (MESSAGE_MAX), it goes out whole as
     * consecutive messages broken between paragraphs (lib/chat-post-split.ts),
     * never cut short with a link: not everyone who reads a channel can open
     * the page the whole text lives on.
     */
    body: string;
    /** Ping everyone who can read the channel. Staff-only in the chat UI. Rides the first message only. */
    mentionEveryone?: boolean;
    /** People who get no chat bell for this post (they were already told another way). */
    excludeBells?: readonly string[];
  },
): Promise<PostResult> {
  try {
    const parts = splitPostBody(input.body);
    if (!parts.length) return { ok: false, reason: "Nothing to post." };
    // A person posting from outside the composer is held to the composer's
    // mute (app/chat/actions.ts assertNotLocked): an announcement author who
    // was muted in chat can still send the announcement, but not its chat
    // copy. Staff are never muted (personalLocks), even by a mute row left
    // over from before they ran chat.
    if (input.senderId && (await isMuted(input.senderId)) && !(await getPerson(input.senderId))?.isStaff) {
      return { ok: false, reason: MUTED_REASON };
    }
    const admin = createAdminClient();
    const lookup = admin
      .from("chat_channels")
      .select("id, kind, name, archived_at");
    const { data: channel, error } = await ("systemKey" in target
      ? lookup.eq("system_key", target.systemKey)
      : lookup.eq("id", target.channelId)
    ).maybeSingle();
    if (error) {
      if (isMissingSchemaError(error)) return { ok: false, reason: "Chat isn't set up yet (migration 0101)." };
      return { ok: false, reason: error.message };
    }
    if (!channel) return { ok: false, reason: "That channel doesn't exist." };
    if ((channel as { archived_at: string | null }).archived_at) {
      return { ok: false, reason: "That channel is archived." };
    }
    const channelId = (channel as { id: string }).id;

    // One insert per message, in order: each gets its own created_at, which is
    // what the channel sorts by. Only the first carries @everyone. All or
    // nothing: a post that stops partway is taken back, so the channel never
    // shows half an announcement.
    const messageIds: string[] = [];
    for (const [n, body] of parts.entries()) {
      const { data: row, error: insErr } = await admin
        .from("chat_messages")
        .insert({
          channel_id: channelId,
          sender_id: input.senderId,
          body,
          kind: input.senderId ? "message" : "system",
          mention_everyone: n === 0 && !!input.mentionEveryone,
        })
        .select("id")
        .single();
      if (insErr || !row) {
        if (messageIds.length) {
          const { error: undoErr } = await admin.from("chat_messages").delete().in("id", messageIds);
          if (undoErr) console.error("[chat-post] couldn't take back a partial post", undoErr.message);
        }
        return { ok: false, reason: insErr?.message ?? "Couldn't post." };
      }
      messageIds.push((row as { id: string }).id);
    }

    // One bell for the whole post, on its first message.
    const messageId = messageIds[0];
    if (input.senderId) {
      await notifyNewMessage({
        channelId,
        messageId,
        senderId: input.senderId,
        mentions: [],
        mentionEveryone: !!input.mentionEveryone,
        excludeBells: input.excludeBells,
      }).catch((err) => console.error("[chat-post] notify failed", err));
    }
    return { ok: true, messageId, messageIds, channelId };
  } catch (err) {
    console.error("[chat-post] failed", err);
    return { ok: false, reason: err instanceof Error ? err.message : "Couldn't post." };
  }
}

/** The team's own channel id, or null before 0101 / for a team without one. */
export async function teamChannelId(teamId: string): Promise<string | null> {
  try {
    const { data, error } = await createAdminClient()
      .from("chat_channels")
      .select("id")
      .eq("system_key", `team:${teamId}`)
      .maybeSingle();
    if (error) return null;
    return (data as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * One line in #staff, the team-only channel: the feed the Discord admin
 * channel used to carry (new applications, acceptances, enrollments, refunds,
 * pass requests, challenge entries), each line built by lib/staff-feed.ts
 * from a name, what happened and an admin link — never an email or an
 * amount. Posted as a system line that still counts as unread there
 * (chat_counts_as_message in 0101), never pings, and never throws — the job
 * that triggered it has already happened.
 */
export async function postStaffFeed(text: string): Promise<void> {
  const res = await postToChannel({ systemKey: "staff" }, { senderId: null, body: text });
  if (!res.ok && !/isn't set up yet/.test(res.reason)) console.error("[chat-post] staff feed", res.reason);
}
