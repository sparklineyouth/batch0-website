import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { addChatHelpNote, createChatHelpTicket, discardChatHelpTicket, reopenChatHelpTicket } from "@/lib/support";
import type { ChannelRow } from "@/lib/chat";
import { ensureThreadRow, getHelpTicket, getThreadRow } from "@/lib/chat-threads";
import { helpReferenceFor, helpRequestPlan } from "@/lib/chat-threads-rules";

/**
 * "Ask the team" on a Chat message (migration 0110): ONE help request per
 * thread, kept in Support, where it has an owner and an open/handled state
 * like any request — the one record. The thread points at it
 * (chat_threads.help_ticket_id) and shows its state; the admin Overview's
 * Support rows read it; nothing keeps a second copy anywhere.
 *
 *   no request yet, or a closed one   a new ticket, linked to the thread
 *   one in the team's queue (open)    that ticket, and a team-only note
 *                                     saying who asked again
 *   one waiting on the asker, or      that ticket, back in the queue (open,
 *   a resolved one                    needs a reply, the clock from now),
 *                                     with the note
 *
 * The answer names the ticket's reference only to the person who filed it
 * and to the team (helpReferenceFor, as the thread pane shows it): a second
 * person asking in the thread is told the team heard them, not handed the
 * reference of someone else's Support request.
 *
 * Two people asking at the same instant: each makes a ticket, and the link
 * is a conditional update on what the thread had — whoever loses takes their
 * ticket back down and is linked to the winner's, so the thread still has
 * one request (0110's unique index keeps a ticket on one thread too).
 *
 * Educational help only. A worry about someone's safety is a Report, which
 * stays its own queue with its own rules about who may see it; the dialog
 * says so, and nothing here ever marks a ticket confidential.
 */

export type HelpRequestOutcome = "created" | "linked" | "reopened";

export type HelpRequestResult = {
  ticketId: string;
  /** For the person who filed the request and the team only; null for anyone else asking. */
  reference: string | null;
  outcome: HelpRequestOutcome;
  /** The asker is the request's requester (it's theirs: emails and their Support page). */
  yours: boolean;
};

/** Who's asking, from their profile — the ticket's requester (the email never leaves the server). */
async function requester(userId: string): Promise<{ name: string | null; email: string | null }> {
  const { data, error } = await createAdminClient().from("profiles").select("full_name, email").eq("id", userId).maybeSingle();
  if (error) throw new Error(`Couldn't load your account: ${error.message}`);
  const r = (data ?? {}) as { full_name?: string | null; email?: string | null };
  return { name: r.full_name?.trim() || null, email: r.email ?? null };
}

/**
 * File or link this thread's help request. `rootId` is the message that
 * starts the thread (the caller has checked it's a person's message in this
 * readable text channel); `messageId` is the one "Ask the team" was pressed
 * on, which may be a reply in it.
 */
export async function requestThreadHelp(input: {
  channel: ChannelRow;
  rootId: string;
  messageId: string;
  askerId: string;
  /** The asker reads Support (support.view): the team sees every reference. */
  askerIsTeam: boolean;
  note: string;
}): Promise<HelpRequestResult> {
  const { channel, rootId } = input;
  const answer = (ticket: { id: string; reference: string; userId: string | null }, outcome: HelpRequestOutcome): HelpRequestResult => ({
    ticketId: ticket.id,
    reference: helpReferenceFor(ticket, { userId: input.askerId, team: input.askerIsTeam }),
    outcome,
    yours: !!ticket.userId && ticket.userId === input.askerId,
  });
  await ensureThreadRow(rootId, channel.id);
  const who = await requester(input.askerId);
  const name = who.name ?? "Someone";
  const about = input.messageId !== rootId ? " about a reply in the thread" : "";
  const again = `${name} asked the team again${about}${input.note ? `: ${input.note}` : "."}`;
  const admin = createAdminClient();

  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getThreadRow(rootId);
    const existing = row?.helpTicketId ? await getHelpTicket(row.helpTicketId) : null;
    const plan = helpRequestPlan(existing);
    if (existing && plan === "reopen") {
      // Back to the team, from the status we saw. If it moved meanwhile (the
      // team answered, the cron resolved it), look again rather than leave
      // it out of the queue.
      const from = existing.status === "resolved" ? "resolved" : "waiting_on_requester";
      if (!(await reopenChatHelpTicket(existing.id, from))) continue;
      await addChatHelpNote(existing.id, again);
      return answer(existing, "reopened");
    }
    if (existing && plan === "link") {
      await addChatHelpNote(existing.id, again);
      return answer(existing, "linked");
    }

    const made = await createChatHelpTicket({
      userId: input.askerId,
      email: who.email,
      name: who.name,
      channelName: channel.name,
      chatThread: { channelId: channel.id, rootId },
      note: input.note,
    });
    // Linked only if the thread still has what we saw: none, or that closed one.
    let link = admin.from("chat_threads").update({ help_ticket_id: made.id }).eq("root_id", rootId);
    link = row?.helpTicketId ? link.eq("help_ticket_id", row.helpTicketId) : link.is("help_ticket_id", null);
    const { data, error } = await link.select("root_id");
    if (error) {
      await discardChatHelpTicket(made.id);
      throw new Error(`Couldn't file that help request: ${error.message}`);
    }
    if ((data ?? []).length > 0) return answer({ ...made, userId: input.askerId }, "created");
    // Someone else's request landed first: it's the thread's, ours goes.
    await discardChatHelpTicket(made.id);
  }
  throw new Error("Couldn't file that help request. Try again in a moment.");
}
