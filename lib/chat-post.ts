import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { fitPostBody } from "@/lib/chat-access";
import { notifyNewMessage } from "@/lib/chat-notify";

/**
 * Posting into a channel from somewhere other than the chat UI: an
 * announcement cross-posted into #announcements, a system line in a team
 * channel. The one door for that, so every caller gets the same rules —
 * the body cap, the "not set up yet" fallback before migration 0101, and the
 * same bells a person's message would ring.
 *
 * Never throws. A post that can't happen is reported, not raised: none of the
 * callers should fail their own job (sending the announcement email, say)
 * because the chat copy didn't land.
 */

export type PostTarget = { systemKey: string } | { channelId: string };

export type PostResult =
  | { ok: true; messageId: string; channelId: string }
  | { ok: false; reason: string };

export async function postToChannel(
  target: PostTarget,
  input: {
    /** Null posts as batch0 itself (a system line). */
    senderId: string | null;
    body: string;
    /** Ping everyone who can read the channel. Staff-only in the chat UI. */
    mentionEveryone?: boolean;
    /**
     * Where the whole thing lives (an announcement's page). Appended, after
     * "…", only when the body has to be cut to fit MESSAGE_MAX — so a long
     * post never just stops mid-sentence.
     */
    link?: string;
    /** People who get no chat bell for this post (they were already told another way). */
    excludeBells?: readonly string[];
  },
): Promise<PostResult> {
  try {
    const body = fitPostBody(input.body, input.link);
    if (!body) return { ok: false, reason: "Nothing to post." };
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

    const { data: row, error: insErr } = await admin
      .from("chat_messages")
      .insert({
        channel_id: (channel as { id: string }).id,
        sender_id: input.senderId,
        body,
        kind: input.senderId ? "message" : "system",
        mention_everyone: !!input.mentionEveryone,
      })
      .select("id, created_at")
      .single();
    if (insErr || !row) return { ok: false, reason: insErr?.message ?? "Couldn't post." };

    const messageId = (row as { id: string }).id;
    if (input.senderId) {
      await notifyNewMessage({
        channelId: (channel as { id: string }).id,
        messageId,
        senderId: input.senderId,
        mentions: [],
        mentionEveryone: !!input.mentionEveryone,
        excludeBells: input.excludeBells,
      }).catch((err) => console.error("[chat-post] notify failed", err));
    }
    return { ok: true, messageId, channelId: (channel as { id: string }).id };
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
