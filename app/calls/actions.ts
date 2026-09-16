"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { env } from "@/lib/env";
import type { CallInviteStatus } from "@/lib/live";

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
    const { data: me } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", actor.userId)
      .maybeSingle();
    await notify({
      userId: (invite as any).host_id,
      type: "call_response",
      title: `${(me as any)?.full_name || "A student"} ${response} your 1:1`,
      body: (invite as any).topic || null,
      link: "/dashboard/calls",
    });
  } catch (err) {
    console.error("[calls] response notify failed", err);
  }

  revalidateAll();
}

/** Cancel. Host (or an admin) only. */
export async function cancelInvite(id: string) {
  const actor = await requireActor();
  const admin = createAdminClient();

  const { data: invite } = await admin
    .from("call_invites")
    .select("id, host_id, invitee_id, daily_room_name, topic")
    .eq("id", id)
    .maybeSingle();
  if (!invite) throw new Error("That invite no longer exists.");

  const isHost = (invite as any).host_id === actor.userId;
  if (!isHost && !actor.caps.superAdmin) throw new Error("Forbidden");

  const { error } = await admin
    .from("call_invites")
    .update({ status: "cancelled" })
    .eq("id", id);
  if (error) throw new Error(error.message);

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
  });

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

  revalidateAll();
}
