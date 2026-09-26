"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { refundScholarshipCreditFor } from "@/lib/calls";
import { can } from "@/lib/permissions";
import { capabilitiesForRole } from "@/lib/roles";
import type { CallInviteStatus } from "@/lib/live";
import {
  callPhase,
  canCancelCall,
  canMarkCallCompleted,
  canRespondToCall,
  hostCallsHref,
  isPastPhase,
  type CallTiming,
} from "@/lib/call-lifecycle";

/**
 * Server actions for staff-initiated 1:1 calls.
 *
 * Lives in app/calls/ — a folder with no page.tsx, so it defines no route —
 * because all four surfaces need the same actions: /mentor/calls,
 * /investor/calls, /admin/calls, and the student's /dashboard/calls.
 *
 * Every mutation re-checks authorization here. Page-level guards are not
 * enough: a server action is its own entry point, callable by anyone who can
 * guess its id, so the page having rendered proves nothing about the caller.
 */

// The interview card on /dashboard and /dashboard/enrolled reads the state of
// the call it booked (lib/call-lifecycle.ts interviewStage), so a call that is
// cancelled, declined or ended changes what those pages say too.
const PATHS = [
  "/dashboard",
  "/dashboard/enrolled",
  "/dashboard/calls",
  "/mentor/calls",
  "/investor/calls",
  "/admin/calls",
];

function revalidateAll() {
  for (const p of PATHS) revalidatePath(p);
}

/** A call_invites row, read as the three facts lib/call-lifecycle.ts needs. */
function timingOf(row: any): CallTiming {
  return {
    status: row.status as CallInviteStatus,
    startsAt: row.starts_at,
    durationMinutes: row.duration_minutes,
  };
}

export async function createInvite(input: {
  inviteeId: string;
  startsAt: string;
  durationMinutes: number;
  topic: string;
}) {
  // The capability, not the role. Migration 0059 grants calls.invite to the
  // mentor and investor roles, but an admin can hand it to any custom role
  // from /admin/roles — so checking role slugs here would quietly ignore that.
  const actor = await assertPermission("calls.invite");
  const admin = createAdminClient();

  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    throw new Error("That date isn't valid.");
  }
  if (startsAt.getTime() < Date.now()) {
    throw new Error("That time is in the past.");
  }
  const duration = Math.round(input.durationMinutes);
  if (duration < 5 || duration > 240) {
    throw new Error("Calls run between 5 and 240 minutes.");
  }

  // Confirm the invitee is really a student before writing. Without this the
  // action would accept any profile id the client posted, including another
  // staff member's — the picker only ever offers students, but the picker is
  // not the boundary.
  const { data: invitee } = await admin
    .from("profiles")
    .select("id, role, email, full_name")
    .eq("id", input.inviteeId)
    .maybeSingle();
  if (!invitee || (invitee as any).role !== "student") {
    throw new Error("You can only invite students.");
  }
  if ((invitee as any).id === actor.userId) {
    throw new Error("You can't invite yourself.");
  }

  const { data: created, error } = await admin
    .from("call_invites")
    .insert({
      host_id: actor.userId,
      invitee_id: input.inviteeId,
      starts_at: startsAt.toISOString(),
      duration_minutes: duration,
      topic: input.topic.trim() || null,
      status: "invited",
    })
    .select("id")
    .single();

  if (error) {
    // The unique constraint is (host_id, invitee_id, starts_at) — a repeat is
    // a double-submit, not something worth surfacing as a database error.
    if (error.code === "23505") {
      throw new Error("You've already invited them to that time.");
    }
    throw new Error(error.message);
  }

  const id = created!.id;

  await logAudit({
    action: "call_invite.created",
    targetType: "call_invite",
    targetId: id,
    payload: { invitee_id: input.inviteeId, starts_at: startsAt.toISOString() },
  });

  // Best-effort: an invite that saved but couldn't email is still an invite,
  // and it's visible on their dashboard either way.
  try {
    const { data: hostProfile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", actor.userId)
      .maybeSingle();
    const hostName = (hostProfile as any)?.full_name || "A member of the team";

    await notify({
      userId: input.inviteeId,
      type: "call_invited",
      title: `${hostName} invited you to a 1:1`,
      body: input.topic.trim() || "Open your calls to accept or decline.",
      link: "/dashboard/calls",
    });

    const email = (invitee as any).email as string | null;
    if (email) {
      const t = Templates.callInvite({
        hostName,
        startsAt: startsAt.toISOString(),
        durationMinutes: duration,
        topic: input.topic.trim() || null,
      });
      await sendEmail({ to: email, subject: t.subject, html: t.html });
    }
  } catch (err) {
    console.error("[calls] invite notify failed", err);
  }

  revalidateAll();
  return { id };
}

/**
 * Accept or decline. Invitee only.
 *
 * Split from the host's cancel path on purpose. RLS lets either party update
 * the row — it can't express "this party may only touch this column" — so the
 * narrower rule lives here, and the two callers can't be confused for each
 * other.
 */
export async function respondToInvite(
  id: string,
  response: Extract<CallInviteStatus, "accepted" | "declined">,
) {
  const actor = await requireActor();
  const admin = createAdminClient();

  if (response !== "accepted" && response !== "declined") {
    throw new Error("That isn't an answer to an invite.");
  }

  const { data: invite } = await admin
    .from("call_invites")
    .select("id, invitee_id, host_id, status, topic, starts_at, duration_minutes")
    .eq("id", id)
    .maybeSingle();
  if (!invite) throw new Error("That invite no longer exists.");
  if ((invite as any).invitee_id !== actor.userId) {
    throw new Error("Forbidden");
  }
  if ((invite as any).status !== "invited") {
    throw new Error("That invite has already been answered.");
  }
  // The time has to still be ahead (or running). Accepting an invite whose
  // window has closed used to succeed, and left the student holding an
  // "accepted" call that no join gate would ever open.
  if (!canRespondToCall(timingOf(invite))) {
    throw new Error(
      "That call's time has passed, so it can't be answered now. Ask them for a new time.",
    );
  }

  const { data: updated, error } = await admin
    .from("call_invites")
    .update({ status: response })
    .eq("id", id)
    // Re-assert the invitee in the WHERE clause, so even a future refactor
    // that loses the check above can't update someone else's row.
    .eq("invitee_id", actor.userId)
    // And the status: two tabs answering at once, or an answer racing the
    // host's cancel, must not both win. The loser updates nothing.
    .eq("status", "invited")
    .select("id");
  if (error) throw new Error(error.message);
  if (!updated || updated.length === 0) {
    throw new Error("That invite has already been answered.");
  }

  // Declining a scholarship-funded call hands its credit back, exactly as the
  // host cancelling it does — either way nobody spoke to anyone.
  if (response === "declined") {
    await refundScholarshipCreditFor(admin, id);
  }

  await logAudit({
    action: `call_invite.${response}`,
    targetType: "call_invite",
    targetId: id,
  });

  try {
    const [{ data: me }, { data: host }] = await Promise.all([
      admin.from("profiles").select("full_name").eq("id", actor.userId).maybeSingle(),
      admin
        .from("profiles")
        .select("role")
        .eq("id", (invite as any).host_id)
        .maybeSingle(),
    ]);
    // The HOST's calls page, not the student view — the same place the room's
    // Back link sends them (hostCallsHref): a mentor sent to /dashboard/calls
    // is bounced to /mentor, and an admin lands on a list of calls where they
    // are the invitee — none — so the call seems to vanish.
    const hostCaps = await capabilitiesForRole(
      ((host as any)?.role as any) ?? "student",
    );
    await notify({
      userId: (invite as any).host_id,
      type: "call_response",
      title: `${(me as any)?.full_name || "A student"} ${response} your 1:1`,
      body: (invite as any).topic || null,
      link: hostCallsHref({
        superAdmin: hostCaps.superAdmin,
        mentorPanel: can(hostCaps, "mentor.panel"),
        investorPanel: can(hostCaps, "investor.panel"),
        canInvite: can(hostCaps, "calls.invite"),
      }),
    });
  } catch (err) {
    console.error("[calls] response notify failed", err);
  }

  revalidateAll();
}

/**
 * Cancel. Host (or an admin) only.
 *
 * Also how an invite that EXPIRED unanswered is withdrawn (see canCancelCall):
 * the same once-only transition and the same scholarship refund, but no
 * "your call was cancelled" notification — the student never agreed to that
 * call, and telling them it was called off would be news about nothing.
 */
export async function cancelInvite(id: string) {
  const actor = await requireActor();
  const admin = createAdminClient();

  const { data: invite } = await admin
    .from("call_invites")
    .select(
      "id, host_id, invitee_id, daily_room_name, topic, status, starts_at, duration_minutes",
    )
    .eq("id", id)
    .maybeSingle();
  if (!invite) throw new Error("That invite no longer exists.");

  const isHost = (invite as any).host_id === actor.userId;
  if (!isHost && !actor.caps.superAdmin) throw new Error("Forbidden");

  // Two refusals the old action never made, each of which cost something.
  //
  // A call that is already cancelled, declined or completed: cancelling it
  // again used to re-run the whole path — a second "your call was cancelled"
  // notification, and a SECOND scholarship credit refund, once per click.
  //
  // An accepted call whose window has closed: it happened (or the student
  // never came), and "cancelling" it afterwards told the student that a
  // meeting they had already had was called off, and refunded the credit it
  // had genuinely used. An unanswered invite past its time is different —
  // canCancelCall lets that one be withdrawn.
  const status = (invite as any).status as CallInviteStatus;
  if (status !== "invited" && status !== "accepted") {
    throw new Error(`That call was already ${status}.`);
  }
  const phase = callPhase(timingOf(invite));
  if (!canCancelCall(timingOf(invite))) {
    throw new Error("That call is already over, so there's nothing to cancel.");
  }
  const withdrawingExpired = phase === "expired";

  const { data: updated, error } = await admin
    .from("call_invites")
    .update({ status: "cancelled" })
    .eq("id", id)
    // Only out of a live status. Two cancels racing (or a cancel racing the
    // student's decline) can't both win, so the refund below runs once.
    .in("status", ["invited", "accepted"])
    .select("id");
  if (error) throw new Error(error.message);
  if (!updated || updated.length === 0) {
    throw new Error("That call has already been answered or cancelled.");
  }

  // Drop the room if one was ever created. Best-effort — rooms expire on
  // their own, so a failure here costs nothing.
  const roomName = (invite as any).daily_room_name as string | null;
  if (roomName) {
    try {
      const { deleteRoom } = await import("@/lib/daily");
      await deleteRoom(roomName);
    } catch (err) {
      console.error("[calls] could not delete room on cancel", err);
    }
  }

  // Hand a learner's-scholarship credit back when the call it paid for is
  // cancelled — see refundScholarshipCreditFor for why, and why only here,
  // after the conditional update above actually changed the row.
  await refundScholarshipCreditFor(admin, id);

  await logAudit({
    action: "call_invite.cancelled",
    targetType: "call_invite",
    targetId: id,
    payload: withdrawingExpired ? { expired_unanswered: true } : undefined,
  });

  if (!withdrawingExpired) {
    try {
      await notify({
        userId: (invite as any).invitee_id,
        type: "call_cancelled",
        title: "A 1:1 call was cancelled",
        body: (invite as any).topic || null,
        link: "/dashboard/calls",
      });
    } catch (err) {
      console.error("[calls] cancel notify failed", err);
    }
  }

  revalidateAll();
}

/**
 * End a call, for both people. Either participant.
 *
 * The room's End call button lands here AFTER the host's recorder has flushed
 * its last segment (see broadcast-room's `finishCall`). The order matters: a
 * flush that ran after this would be racing the page navigating away. The
 * OTHER person's recorder, if they are the host, flushes after the row is
 * already completed, which the upload gate allows (canUploadCallRecording).
 *
 * Marks the call `completed` only once its scheduled start has come
 * (canMarkCallCompleted): two people who joined early and left again have not
 * had their call, and completing it would lock them out of the room at the
 * proper time. Before the start this is a no-op that says so, and the button
 * simply takes them back to their calls.
 *
 * Idempotent: ending a call that is already completed — the other person got
 * there first — succeeds quietly.
 */
export async function endCall(id: string): Promise<{ completed: boolean }> {
  const actor = await requireActor();
  const admin = createAdminClient();

  const { data: invite } = await admin
    .from("call_invites")
    .select("id, host_id, invitee_id, status, starts_at, duration_minutes")
    .eq("id", id)
    .maybeSingle();
  if (!invite) throw new Error("That call no longer exists.");
  const row = invite as any;
  if (row.host_id !== actor.userId && row.invitee_id !== actor.userId) {
    throw new Error("Forbidden");
  }
  if (row.status === "completed") return { completed: true };
  if (!canMarkCallCompleted(timingOf(row))) return { completed: false };

  const { data: updated, error } = await admin
    .from("call_invites")
    .update({ status: "completed" })
    .eq("id", id)
    .eq("status", "accepted")
    .select("id");
  if (error) throw new Error(error.message);
  const completed = !!updated && updated.length > 0;

  if (completed) {
    await logAudit({
      action: "call_invite.completed",
      targetType: "call_invite",
      targetId: id,
      payload: { ended_by: actor.userId },
    });
    revalidateAll();
  }
  return { completed };
}

/**
 * Is this call over? Polled by both people in the room.
 *
 * batch0 Live has no server in the media path, so when one person presses End
 * call the other's browser sees only a peer that went away — which is also
 * what a dropped connection looks like. This is how the room tells the two
 * apart: the row says completed (or cancelled), or the window has closed, and
 * the room closes itself — flushing the host's recording on the way out —
 * instead of sitting on "reconnecting" for half an hour.
 *
 * Null for anyone who is not one of the two, the same non-answer the join
 * gate gives, so it can't be used to learn which calls exist.
 */
export async function getCallRoomStatus(
  id: string,
): Promise<{ over: boolean } | null> {
  const actor = await requireActor();
  const admin = createAdminClient();
  const { data: invite } = await admin
    .from("call_invites")
    .select("id, host_id, invitee_id, status, starts_at, duration_minutes")
    .eq("id", id)
    .maybeSingle();
  const row = invite as any;
  if (!row) return null;
  if (row.host_id !== actor.userId && row.invitee_id !== actor.userId) {
    return null;
  }
  return { over: isPastPhase(callPhase(timingOf(row))) };
}
