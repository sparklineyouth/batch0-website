"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/server-guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { notify, notifyMany } from "@/lib/notifications";
import { runAction, type ActionResult } from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import {
  canStartConversation,
  countUnreadConversations,
  findConversation,
  getConversationForViewer,
  getDmViewer,
  getPerson,
  hasPendingFineFor,
  isBlockedBetween,
  isReported,
  isUuid,
  listBlockedPeople,
  listInbox,
  listMessages,
  listModeratorIds,
  searchDirectory,
  type DmInboxRow,
  type DmMessage,
  type DmPerson,
} from "@/lib/dm";
import {
  cursorColumnFor,
  isParticipant,
  laterTimestamp,
  MESSAGE_MAX,
  orderPair,
  otherParticipant,
  REPORT_REASON_MAX,
  seenColumnFor,
  shouldBell,
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
 * Reads return plain data and throw on failure. Mutations return an
 * ActionResult, because every interesting failure in a chat UI is one the
 * user needs to read: blocked, frozen, too fast, too long.
 *
 * Nothing here calls revalidatePath. Next re-renders the CURRENT route after
 * any action that revalidates any path at all — and the current route is
 * wherever the dock is open: a mentor's home, a challenge's submission form,
 * an admin page. Every send and every mark-as-read used to re-render that
 * whole page, and because server actions run one at a time, each incoming
 * message queued the next send behind a full page render. Nothing needs it:
 * /messages is force-dynamic and the client owns both of its panes.
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

/**
 * The newest messages in a conversation the viewer may read — the open
 * thread's resync. Realtime delivers nothing sent while the channel was
 * joining or disconnected, and nothing about an unsend at all (a filtered
 * DELETE never arrives), so an open thread reconciles against this when it
 * connects, when the tab comes back, and on a slow timer.
 */
export async function fetchMessages(conversationId: string): Promise<{
  messages: DmMessage[];
  /**
   * Everything created before this instant that isn't in `messages` is gone
   * (unsent or removed). Taken before the query, less a margin for clock skew
   * between this server and the database, so a message landing mid-request is
   * never mistaken for a deleted one.
   */
  asOf: string;
  /** False when the list was cut at the limit: older messages exist. */
  complete: boolean;
}> {
  const actor = await requireActor();
  const viewer = await getDmViewer(actor.userId, actor.caps);
  const convo = await getConversationForViewer(conversationId, viewer);
  if (!convo) throw new Error("That conversation isn't available.");
  const asOf = new Date(Date.now() - 3_000).toISOString();
  const messages = await listMessages(convo.id, RESYNC_LIMIT);
  return { messages, asOf, complete: messages.length < RESYNC_LIMIT };
}

const RESYNC_LIMIT = 300;

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
    const viewer = await getDmViewer(actor.userId, actor.caps);

    if (input.conversationId) {
      const convo = await getConversationForViewer(input.conversationId, viewer);
      if (!convo || !isParticipant(convo, actor.userId)) {
        // A moderator reading a reported thread lands here too: readable,
        // never postable.
        throw new Error("That conversation isn't available.");
      }
      existingConversationId = convo.id;
      const other = otherParticipant(convo, actor.userId);
      // Their account has been deleted: the history stays, read-only.
      if (!other) throw new Error("That person isn't on batch0 anymore.");
      recipientId = other;
    } else {
      const to = input.toUserId;
      if (!to) throw new Error("Pick someone to message.");
      if (to === actor.userId) throw new Error("You can't message yourself.");
      const person = await getPerson(to);
      if (!person) throw new Error("That person isn't available.");
      recipientId = to;
      existingConversationId = (await findConversation(actor.userId, to))?.id ?? null;
      // Who may cold-message whom (lib/dm.ts, "Who can reach whom"). Only for
      // a NEW conversation: a reply is never cut off.
      if (!existingConversationId) {
        const allowed = await canStartConversation(viewer, person);
        if (!allowed.ok) throw new Error(allowed.reason);
      }
    }

    // A pending fine locks an account out of everything but paying it
    // (middleware). Server actions from the dock post to whatever page it's
    // on — including the fine page itself — so the lock is enforced here too,
    // leaving one door open: the team, to ask about the fine.
    if (!viewer.moderates && (await hasPendingFineFor(actor.userId))) {
      const recipient = await getPerson(recipientId);
      if (!recipient?.isStaff) {
        throw new Error("Settle your pending fine first. You can still message the batch0 team about it.");
      }
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

    // Does this message earn a bell? Only if the recipient has no unread
    // bell for this conversation already and isn't in it right now (see
    // shouldBell).
    const link = `${BASE}?c=${conversationId}`;
    const [{ data: before }, { count: pendingBells }] = await Promise.all([
      admin
        .from("dm_conversations")
        .select("user_a, user_b, a_seen_at, b_seen_at")
        .eq("id", conversationId)
        .maybeSingle(),
      admin
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", recipientId)
        .eq("type", "direct_message")
        .eq("link", link)
        .is("read_at", null),
    ]);
    const recipientSeenAt = before
      ? ((before as any).user_a === recipientId ? (before as any).a_seen_at : (before as any).b_seen_at)
      : null;
    const bell = shouldBell(
      { recipientSeenAt: recipientSeenAt ?? null, hasUnreadBell: (pendingBells ?? 0) > 0 },
      Date.now(),
    );

    const { data: message, error } = await admin
      .from("dm_messages")
      .insert({ conversation_id: conversationId, sender_id: actor.userId, body })
      .select("id, created_at")
      .single();
    if (error) throw new Error(error.message);

    // last_message_at / preview / count are the trigger's job (0089).
    //
    // One bell per burst, not one per message (see shouldBell). No email —
    // a DM is a conversation, not an announcement. And no body: every admin
    // can read every notification (0016's policy), so a preview here would be
    // a staff read path into unreported DMs. 0089 strips it in SQL as well.
    if (bell) {
      const name = await actorName(actor.userId);
      await notify({
        userId: recipientId,
        type: "direct_message",
        title: `${name} messaged you`,
        link,
      });
    }

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
 * Move the viewer's read cursor up to `upTo` — the timestamp of the newest
 * message their screen is actually showing. Not "now": a message that lands
 * between the thread loading and this call was never on screen, and must stay
 * unread. Never moves backwards, never past the conversation's last message.
 *
 * Which column that is depends on which side of the pair the viewer is on —
 * cursorColumnFor() throws rather than guess, so a stranger passing someone
 * else's conversation id can't clear their unread. Also clears the viewer's
 * bells for this conversation: they've read it.
 */
export async function markRead(
  conversationId: string,
  upTo?: string,
): Promise<ActionResult<{ changed: boolean }>> {
  return runAction({ name: "markRead" }, async () => {
    const actor = await requireActor();
    if (!isUuid(conversationId)) throw new Error("That conversation isn't available.");
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("dm_conversations")
      .select("id, user_a, user_b, a_last_read_at, b_last_read_at, last_message_at")
      .eq("id", conversationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("That conversation isn't available.");
    const row = data as any;
    const scope = { id: row.id, userA: row.user_a, userB: row.user_b };
    if (!isParticipant(scope, actor.userId)) {
      throw new Error("That conversation isn't available.");
    }
    const column = cursorColumnFor(scope, actor.userId);
    const current: string = row[column];
    const last: string | null = row.last_message_at;
    // What the screen showed, capped at the newest message that exists.
    let target = upTo && Number.isFinite(Date.parse(upTo)) ? upTo : (last ?? current);
    if (last && laterTimestamp(target, last) !== last) target = last;
    const next = laterTimestamp(current, target);
    // Always record that they had it open just now — that, not the cursor,
    // is what keeps a live conversation from ringing their bell.
    const { error: upErr } = await admin
      .from("dm_conversations")
      .update({ [column]: next, [seenColumnFor(scope, actor.userId)]: new Date().toISOString() })
      .eq("id", conversationId);
    if (upErr) throw new Error(upErr.message);
    // Caught up: take down this conversation's bells, so the bell and the
    // badge agree.
    let cleared = 0;
    if (!last || laterTimestamp(next, last) === next) {
      const { data: bells } = await admin
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("user_id", actor.userId)
        .eq("type", "direct_message")
        .eq("link", `${BASE}?c=${conversationId}`)
        .is("read_at", null)
        .select("id");
      cleared = bells?.length ?? 0;
    }
    // Whether anything the inbox shows moved, so the client can skip
    // refetching the list when it didn't.
    return { changed: next !== current || cleared > 0 };
  });
}

/**
 * Unsend your own message. Nobody can unsend someone else's words.
 *
 * It disappears for both people at once — every participant read, the
 * Realtime read policy and the conversation's preview all skip unsent rows —
 * but the row stays, readable only by the team if the conversation is ever
 * reported. So a reported sender can't quietly delete the evidence first,
 * and nobody is told anything by the unsend itself: it behaves the same
 * whether or not a report exists.
 */
export async function unsendDm(messageId: string): Promise<ActionResult> {
  return runAction({ name: "unsendDm" }, async () => {
    const actor = await requireActor();
    if (!isUuid(messageId)) throw new Error("That message is already gone.");
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("dm_messages")
      .update({ unsent_at: new Date().toISOString() })
      .eq("id", messageId)
      .eq("sender_id", actor.userId)
      .is("unsent_at", null)
      .select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error("That message is already gone.");
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
    if (!isUuid(userId)) throw new Error("That person isn't available.");
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
  });
}

export async function unblockPerson(userId: string): Promise<ActionResult> {
  return runAction({ name: "unblockPerson" }, async () => {
    const actor = await requireActor();
    if (!isUuid(userId)) throw new Error("That person isn't available.");
    const admin = createAdminClient();
    const { error } = await admin
      .from("dm_blocks")
      .delete()
      .eq("blocker_id", actor.userId)
      .eq("blocked_id", userId);
    if (error) throw new Error(error.message);
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
    const { data: created, error } = await admin
      .from("dm_reports")
      .insert({
        conversation_id: input.conversationId,
        reporter_id: actor.userId,
        reason,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const reporter = await actorName(actor.userId);
    // Pointed at the report, not the conversation, and without the reason:
    // /admin/audit is readable with audit.view, which doesn't imply
    // moderation.manage — and a reported admin must not be able to find
    // their own conversation, the reporter and the reason in it.
    await logAudit({
      action: "dm.report",
      targetType: "dm_report",
      targetId: (created as any).id,
      payload: { length: reason.length },
    });
    // Bell the moderators. Re-reporting an already-open conversation still
    // notifies: a second person speaking up is information. Never either
    // participant: a moderator who is the person being reported must not be
    // the one told about it (and is refused the moderation actions on it).
    const moderators = (await listModeratorIds()).filter(
      (id) => id !== scope.userA && id !== scope.userB,
    );
    if (moderators.length > 0) {
      await notifyMany(
        moderators.map((id) => ({
          userId: id,
          type: "dm_reported",
          title: alreadyOpen
            ? "Another report on a reported conversation"
            : `${reporter} reported a conversation`,
          // No reason in the bell: reasons quote the DM, and admins can read
          // one another's notifications. The queue has it.
          link: `/admin/messages/${input.conversationId}`,
        })),
      );
    }
  });
}
