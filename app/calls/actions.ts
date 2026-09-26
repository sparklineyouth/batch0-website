"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { callPhase, type CallInviteStatus } from "@/lib/live";
import { callsHomeFor } from "@/lib/permissions";
import { capabilitiesForRole } from "@/lib/roles";
import { notifyStage } from "@/lib/live-rooms";

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

const PATHS = [
  "/dashboard/calls",
  "/mentor/calls",
  "/investor/calls",
  "/admin/calls",
];

function revalidateAll() {
  for (const p of PATHS) revalidatePath(p);
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

  const { data: invite } = await admin
    .from("call_invites")
    .select("id, invitee_id, host_id, status, topic, starts_at")
    .eq("id", id)
    .maybeSingle();
  if (!invite) throw new Error("That invite no longer exists.");
  if ((invite as any).invitee_id !== actor.userId) {
    throw new Error("Forbidden");
  }
  if ((invite as any).status !== "invited") {
    throw new Error("That invite has already been answered.");
  }

  const { error } = await admin
    .from("call_invites")
    .update({ status: response })
    .eq("id", id)
    // Re-assert the invitee in the WHERE clause, so even a future refactor
    // that loses the check above can't update someone else's row.
    .eq("invitee_id", actor.userId);
  if (error) throw new Error(error.message);

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
    // The HOST's calls page, not the student view: a mentor sent to
    // /dashboard/calls is bounced to /mentor, and an admin lands on a list of
    // calls where they are the invitee — none — so the call seems to vanish.
    const hostCaps = await capabilitiesForRole(
      ((host as any)?.role as any) ?? "student",
    );
    await notify({
      userId: (invite as any).host_id,
      type: "call_response",
      title: `${(me as any)?.full_name || "A student"} ${response} your 1:1`,
      body: (invite as any).topic || null,
      link: callsHomeFor(hostCaps),
    });
  } catch (err) {
    console.error("[calls] response notify failed", err);
  }

  revalidateAll();
}

/**
 * Cancel a call.
 *
 * Who: the host (inviter) or a superAdmin at any time before the call is
 * over, and the invitee — "Can't make it" — before it starts. Before this the
 * invitee had no way out of an accepted call at all.
 *
 * When: only while the invite is `invited` or `accepted` and the call is not
 * already over (callPhase 'completed' — including an accepted call whose
 * window has closed). Cancelling a call that already happened used to be
 * possible, told the student a completed call was cancelled, and refunded the
 * scholarship credit it had legitimately spent.
 *
 * The write is conditional on the status (`in ('invited','accepted')`) and
 * only its winner does the side effects — room delete, credit refund,
 * notification — so a double click or a second tab can no longer refund the
 * same credit twice.
 *
 * Cancelling a call that is in progress disconnects both people: the
 * content-free `room-changed` on the call's stage topic makes each client
 * re-ask the server, which now answers 'cancelled', and both see "This call
 * was cancelled" instead of talking on while a notification says otherwise.
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
  const inv = invite as any;

  const isHost = inv.host_id === actor.userId;
  const isInvitee = inv.invitee_id === actor.userId;
  const beforeStart = Date.now() < new Date(inv.starts_at).getTime();
  const allowed =
    isHost || actor.caps.superAdmin || (isInvitee && beforeStart);
  if (!allowed) {
    throw new Error(
      isInvitee
        ? "The call has already started — use Leave to step out."
        : "Forbidden",
    );
  }

  const phase = callPhase({
    status: inv.status as CallInviteStatus,
    startsAt: inv.starts_at,
    durationMinutes: inv.duration_minutes,
  });
  if (inv.status !== "invited" && inv.status !== "accepted") {
    throw new Error("That call can't be cancelled any more.");
  }
  if (phase === "completed") {
    throw new Error("That call is already over.");
  }

  const { data: changed, error } = await admin
    .from("call_invites")
    .update({ status: "cancelled" })
    .eq("id", id)
    .in("status", ["invited", "accepted"])
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  // Somebody else changed it first (another tab, the other party, End call).
  // Their write already did the side effects; doing them again is exactly the
  // double refund this guards against.
  if (!changed) throw new Error("That call can't be cancelled any more.");

  // Close the room for anyone in it, first — it is the part the two people on
  // the call notice.
  await notifyStage(`call:${id}`, { t: "room-changed" });

  // Drop the room if one was ever created. Best-effort — rooms expire on
  // their own, so a failure here costs nothing.
  const roomName = inv.daily_room_name as string | null;
  if (roomName) {
    try {
      const { deleteRoom } = await import("@/lib/daily");
      await deleteRoom(roomName);
    } catch (err) {
      console.error("[calls] could not delete room on cancel", err);
    }
  }

  // Hand a learner's-scholarship credit back when the call it paid for is
  // cancelled. The credit was spent at SCHEDULE time (scheduleInterviewRequest),
  // so a cancelled call would otherwise silently consume one of three without
  // the student ever having spoken to anyone.
  //
  // Best-effort and tolerant: a database where 0071 hasn't run has no such
  // requests, and a failure here must not block a cancellation that has already
  // torn down the room.
  try {
    const { data: linked } = await admin
      .from("interview_requests")
      .select("id, scholarship_application_id")
      .eq("call_invite_id", id)
      .maybeSingle();
    const scholarshipAppId = (linked as any)?.scholarship_application_id ?? null;
    if (scholarshipAppId) {
      const { refundCallCredit } = await import("@/lib/scholarships");
      await refundCallCredit(admin, scholarshipAppId);
    }
  } catch (err) {
    console.error("[calls] scholarship credit refund failed", err);
  }

  await logAudit({
    action: "call_invite.cancelled",
    targetType: "call_invite",
    targetId: id,
    payload: { by: isHost ? "host" : isInvitee ? "invitee" : "admin" },
  });

  // Tell whichever party did NOT cancel. An invitee backing out tells the
  // host (on the host's own calls page); a host cancelling tells the invitee;
  // a superAdmin cancelling someone else's call tells both of them.
  try {
    if (isInvitee && !isHost) {
      const [{ data: me }, { data: host }] = await Promise.all([
        admin.from("profiles").select("full_name").eq("id", actor.userId).maybeSingle(),
        admin.from("profiles").select("role").eq("id", inv.host_id).maybeSingle(),
      ]);
      const hostCaps = await capabilitiesForRole(
        ((host as any)?.role as any) ?? "student",
      );
      await notify({
        userId: inv.host_id,
        type: "call_cancelled",
        title: `${(me as any)?.full_name || "A student"} can't make your 1:1`,
        body: inv.topic || null,
        link: callsHomeFor(hostCaps),
      });
    } else {
      await notify({
        userId: inv.invitee_id,
        type: "call_cancelled",
        title: "A 1:1 call was cancelled",
        body: inv.topic || null,
        link: "/dashboard/calls",
      });
      if (!isHost) {
        const { data: host } = await admin
          .from("profiles")
          .select("role")
          .eq("id", inv.host_id)
          .maybeSingle();
        const hostCaps = await capabilitiesForRole(
          ((host as any)?.role as any) ?? "student",
        );
        await notify({
          userId: inv.host_id,
          type: "call_cancelled",
          title: "An admin cancelled your 1:1",
          body: inv.topic || null,
          link: callsHomeFor(hostCaps),
        });
      }
    }
  } catch (err) {
    console.error("[calls] cancel notify failed", err);
  }

  revalidateAll();
}
