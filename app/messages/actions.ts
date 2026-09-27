"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/server-guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { notify, notifyMany } from "@/lib/notifications";
import { runAction, type ActionResult } from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import {
  countUnreadConversations,
  findConversation,
  getConversationForViewer,
  getDmViewer,
  getPerson,
  isBlockedBetween,
  isReported,
  listBlockedPeople,
  listInbox,
  listModeratorIds,
  searchDirectory,
  type DmInboxRow,
  type DmPerson,
} from "@/lib/dm";
import {
  cursorColumnFor,
  hasUnread,
  isParticipant,
  MESSAGE_MAX,
  orderPair,
  otherParticipant,
  REPORT_REASON_MAX,
} from "@/lib/dm-access";
import { buildThreadPayload, type ThreadPayload } from "@/lib/dm-thread";

/**
 * Server actions for direct messages (migration 0089).
 *
 * These double as the read API for the chat popup: it's a client component
 * that has to fetch on demand, and a server action is a narrower door than a
 * route handler — no URL to guess, and the actor is re-derived here every
 * time. A page guard is not what protects any of this.
 *
 * Reads return plain data and throw only on "not signed in". Mutations return
 * an ActionResult, because every interesting failure in a chat UI is one the
 * user needs to read: blocked, frozen, too fast, too long.
 */

const BASE = "/messages";

function cleanBody(s: string): string {
  const b = s.trim();
  if (!b) throw new Error("Write a message first.");
  if (b.length > MESSAGE_MAX) {
    throw new Error(`That message is too long (max ${MESSAGE_MAX} characters).`);
  }
  return b;
}

async function actorName(userId: string): Promise<string> {
  const person = await getPerson(userId);
  return person?.name ?? "Someone";
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchUnreadCount(): Promise<number> {
  const actor = await requireActor();
  return countUnreadConversations(actor.userId);
}

export async function fetchInbox(): Promise<DmInboxRow[]> {
  const actor = await requireActor();
  return listInbox(actor.userId);
}

export async function searchPeople(query: string): Promise<DmPerson[]> {
  const actor = await requireActor();
  const viewer = await getDmViewer(actor.userId, actor.caps);
  return searchDirectory(query, viewer);
}

export async function fetchBlockedPeople(): Promise<DmPerson[]> {
  const actor = await requireActor();
  return listBlockedPeople(actor.userId);
}

export type { ThreadPayload } from "@/lib/dm-thread";

/**
 * Everything a thread needs, by conversation id or by person. Called by the
 * popup on open and on every conversation switch. Shares its builder with the
 * full page's server render (lib/dm-thread.ts), so the two surfaces cannot
 * disagree about who may see what.
 */
export async function fetchThread(input: {
  conversationId?: string;
  withUserId?: string;
}): Promise<ThreadPayload> {
  const actor = await requireActor();
  const viewer = await getDmViewer(actor.userId, actor.caps);
  const payload = await buildThreadPayload(viewer, input);
  // Same answer for "no such conversation", "not yours", and "no such person".
  if (!payload) throw new Error("That conversation isn't available.");
  return payload;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Find-or-create the conversation for a pair. The ordered pair plus the unique
 * index (0089) is what makes this safe under a race: if both people press
 * send at the same instant, one insert loses and reads the winner back rather
 * than creating a second conversation.
 */
async function ensureConversation(me: string, other: string): Promise<{ id: string; created: boolean }> {
  const existing = await findConversation(me, other);
  if (existing) return { id: existing.id, created: false };

  const { userA, userB } = orderPair(me, other);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("dm_conversations")
    .insert({ user_a: userA, user_b: userB })
    .select("id")
    .single();
  if (error) {
    const again = await findConversation(me, other);
    if (again) return { id: again.id, created: false };
    throw new Error(error.message);
  }
  return { id: (data as any).id as string, created: true };
}

/**
 * Send a message — into an existing conversation, or to a person, in which
 * case the conversation is created here on the first message. That's why a
 * "draft" thread creates nothing: an inbox full of empty conversations
 * somebody opened and thought better of is noise.
 */
export async function sendDm(input: {
  conversationId?: string;
  toUserId?: string;
  body: string;
}): Promise<ActionResult<{ conversationId: string; messageId: string; createdAt: string }>> {
  return runAction({ name: "sendDm" }, async () => {
    const actor = await requireActor();
    const body = cleanBody(input.body);
    const admin = createAdminClient();

    // Work out who this is going to, and whether it's allowed, BEFORE anything
    // is written. Order matters: creating the conversation first would let a
    // blocked sender push empty "no messages yet" rows into the inbox of the
    // person who blocked them, one per attempt.
    let existingConversationId: string | null = null;
    let recipientId: string;

    if (input.conversationId) {
      const convo = await getConversationForViewer(
        input.conversationId,
        await getDmViewer(actor.userId, actor.caps),
      );
      if (!convo || !isParticipant(convo, actor.userId)) {
        // A moderator reading a reported thread lands here too: readable,
        // never postable.
        throw new Error("That conversation isn't available.");
      }
      existingConversationId = convo.id;
      recipientId = otherParticipant(convo, actor.userId);
    } else {
      const to = input.toUserId;
      if (!to) throw new Error("Pick someone to message.");
      if (to === actor.userId) throw new Error("You can't message yourself.");
      const person = await getPerson(to);
      if (!person) throw new Error("That person isn't available.");
      recipientId = to;
      existingConversationId = (await findConversation(actor.userId, to))?.id ?? null;
    }

    if (await isBlockedBetween(actor.userId, recipientId)) {
      // Intentionally does not say who blocked whom. If the viewer is the
      // blocker the UI already knows from `blockedByYou` and says so there.
      throw new Error("You can't send messages in this conversation.");
    }

    // Opening a brand-new conversation is the spammable act — cold outreach to
    // a stranger — so it carries its own slower limit on top of the per-message
    // one below.
    if (!existingConversationId) {
      const newRl = await checkRateLimit({
        kind: "dm-new-conversation",
        identifier: actor.userId,
        limit: 10,
        windowSeconds: 3600,
      });
      if (!newRl.ok) {
        throw new Error(
          "You've started a lot of new conversations in the last hour. Try again later.",
        );
      }
    }

    const rl = await checkRateLimit({
      kind: "dm-message",
      identifier: actor.userId,
      limit: 30,
      windowSeconds: 60,
    });
    if (!rl.ok) throw new Error("Slow down — too many messages in a row.");

    const conversationId =
      existingConversationId ??
      (await ensureConversation(actor.userId, recipientId)).id;

    // Read the conversation BEFORE inserting: whether the recipient is
    // currently caught up is what decides if this message earns a bell, and
    // the insert's trigger is about to change the answer.
    const { data: before } = await admin
      .from("dm_conversations")
      .select(
        "id, user_a, user_b, a_last_read_at, b_last_read_at, last_message_at, last_sender_id, message_count, created_at, last_message_preview",
      )
      .eq("id", conversationId)
      .maybeSingle();
    const recipientWasCaughtUp = before
      ? !hasUnread(
          {
            id: (before as any).id,
            userA: (before as any).user_a,
            userB: (before as any).user_b,
            aLastReadAt: (before as any).a_last_read_at,
            bLastReadAt: (before as any).b_last_read_at,
            lastMessageAt: (before as any).last_message_at,
            lastSenderId: (before as any).last_sender_id,
          },
          recipientId,
        )
      : true;

    const { data: message, error } = await admin
      .from("dm_messages")
      .insert({ conversation_id: conversationId, sender_id: actor.userId, body })
      .select("id, created_at")
      .single();
    if (error) throw new Error(error.message);

    // last_message_at / preview / count are the trigger's job (0089).
    //
    // One bell per burst, not one per message: a conversation the recipient
    // hasn't caught up on already has an unread bell pointing at it, and
    // twenty more would be twenty ways to say the same thing. No email —
    // a DM is a conversation, not an announcement, and mailing every line
    // would make the feature unusable.
    if (recipientWasCaughtUp) {
      const name = await actorName(actor.userId);
      await notify({
        userId: recipientId,
        type: "direct_message",
        title: `${name} messaged you`,
        body: body.slice(0, 200),
        link: `${BASE}?c=${conversationId}`,
      });
    }

    revalidatePath(BASE);
    return {
      conversationId,
      messageId: (message as any).id as string,
      createdAt: (message as any).created_at as string,
    };
  });
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

/**
 * Move the viewer's own read cursor to now. Which column that is depends on
 * which side of the pair they're on — cursorColumnFor() throws rather than
 * guess, so a stranger passing someone else's conversation id can't clear
 * their unread.
 */
export async function markRead(conversationId: string): Promise<ActionResult> {
  return runAction({ name: "markRead" }, async () => {
    const actor = await requireActor();
    const admin = createAdminClient();
    const { data } = await admin
      .from("dm_conversations")
      .select("id, user_a, user_b")
      .eq("id", conversationId)
      .maybeSingle();
    if (!data) throw new Error("That conversation isn't available.");
    const scope = {
      id: (data as any).id,
      userA: (data as any).user_a,
      userB: (data as any).user_b,
    };
    if (!isParticipant(scope, actor.userId)) {
      throw new Error("That conversation isn't available.");
    }
    await admin
      .from("dm_conversations")
      .update({ [cursorColumnFor(scope, actor.userId)]: new Date().toISOString() })
      .eq("id", conversationId);
    revalidatePath(BASE);
  });
}

/** Unsend your own message. Nobody can delete someone else's words here. */
export async function unsendDm(messageId: string): Promise<ActionResult> {
  return runAction({ name: "unsendDm" }, async () => {
    const actor = await requireActor();
    const admin = createAdminClient();
    const { data } = await admin
      .from("dm_messages")
      .select("id, sender_id, conversation_id")
      .eq("id", messageId)
      .maybeSingle();
    if (!data) throw new Error("That message is already gone.");
    if ((data as any).sender_id !== actor.userId) {
      throw new Error("You can only unsend your own messages.");
    }
    const { error } = await admin.from("dm_messages").delete().eq("id", messageId);
    if (error) throw new Error(error.message);
    revalidatePath(BASE);
  });
}

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

/**
 * Block someone. Symmetric in effect (see dm_is_blocked in 0089): neither of
 * you can send afterwards, and both keep the history. Never notifies the
 * person blocked — silence is the entire point.
 */
export async function blockPerson(userId: string): Promise<ActionResult> {
  return runAction({ name: "blockPerson" }, async () => {
    const actor = await requireActor();
    if (userId === actor.userId) throw new Error("You can't block yourself.");
    const person = await getPerson(userId);
    if (!person) throw new Error("That person isn't available.");
    const admin = createAdminClient();
    const { error } = await admin
      .from("dm_blocks")
      .upsert(
        { blocker_id: actor.userId, blocked_id: userId },
        { onConflict: "blocker_id,blocked_id", ignoreDuplicates: true },
      );
    if (error) throw new Error(error.message);
    revalidatePath(BASE);
  });
}

export async function unblockPerson(userId: string): Promise<ActionResult> {
  return runAction({ name: "unblockPerson" }, async () => {
    const actor = await requireActor();
    const admin = createAdminClient();
    const { error } = await admin
      .from("dm_blocks")
      .delete()
      .eq("blocker_id", actor.userId)
      .eq("blocked_id", userId);
    if (error) throw new Error(error.message);
    revalidatePath(BASE);
  });
}

// ---------------------------------------------------------------------------
// Reporting — the one thing that opens a DM to the team
// ---------------------------------------------------------------------------

/**
 * Report a conversation. This is what grants `moderation.manage` holders read
 * access to it (dm_can_read_conversation in 0089), so the UI says as much
 * before the reporter confirms: an unreported DM has no staff read path, and
 * reporting hands over the whole thread.
 */
export async function reportDm(input: {
  conversationId: string;
  reason: string;
}): Promise<ActionResult> {
  return runAction({ name: "reportDm" }, async () => {
    const actor = await requireActor();
    const reason = input.reason.trim();
    if (!reason) throw new Error("Tell us what's wrong so we can act on it.");
    if (reason.length > REPORT_REASON_MAX) {
      throw new Error("That's too long — a sentence or two is plenty.");
    }

    const admin = createAdminClient();
    const { data } = await admin
      .from("dm_conversations")
      .select("id, user_a, user_b")
      .eq("id", input.conversationId)
      .maybeSingle();
    if (!data) throw new Error("That conversation isn't available.");
    const scope = {
      id: (data as any).id,
      userA: (data as any).user_a,
      userB: (data as any).user_b,
    };
    // Only a party to the conversation may report it. A moderator already
    // looking at a reported one has no business adding reports to it.
    if (!isParticipant(scope, actor.userId)) {
      throw new Error("That conversation isn't available.");
    }

    const rl = await checkRateLimit({
      kind: "dm-report",
      identifier: actor.userId,
      limit: 10,
      windowSeconds: 3600,
    });
    if (!rl.ok) throw new Error("You've filed several reports just now. Try again later.");

    const alreadyOpen = await isReported(input.conversationId);
    const { error } = await admin.from("dm_reports").insert({
      conversation_id: input.conversationId,
      reporter_id: actor.userId,
      reason,
    });
    if (error) throw new Error(error.message);

    const reporter = await actorName(actor.userId);
    await logAudit({
      action: "dm.report",
      targetType: "dm_conversation",
      targetId: input.conversationId,
      payload: { reason: reason.slice(0, 200) },
    });
    // Bell the moderators. Re-reporting an already-open conversation still
    // notifies: a second person speaking up is information.
    const moderators = (await listModeratorIds()).filter((id) => id !== actor.userId);
    if (moderators.length > 0) {
      await notifyMany(
        moderators.map((id) => ({
          userId: id,
          type: "dm_reported",
          title: alreadyOpen
            ? "Another report on a reported conversation"
            : `${reporter} reported a conversation`,
          body: reason.slice(0, 200),
          link: `/admin/messages/${input.conversationId}`,
        })),
      );
    }
  });
}
