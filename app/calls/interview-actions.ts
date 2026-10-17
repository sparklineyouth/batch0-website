"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { getStudentAccess } from "@/lib/access";
import { getInterviewRequest, listInterviewTeamIds } from "@/lib/interview-requests";
import { logAudit } from "@/lib/audit";
import { refuse, runAction, type ActionResult } from "@/lib/action-result";
import {
  callDurationProblem,
  callStartProblem,
  canRequestTeamCall,
  formatEasternDateTime,
} from "@/lib/call-lifecycle";
import { spendCallCredit, scholarshipApplicationIdForRequest } from "@/lib/scholarships";
import { notify, notifyMany } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { attachCohosts, notifyCohostsAdded, resolveCohosts } from "@/lib/calls";

/**
 * "Request a 1:1" (interview_requests, migration 0061): an enrolled student
 * asks the team for a call, the team books a time (a real call_invites row)
 * or declines. One open request per student. Every action re-checks
 * authorization; the student side re-derives the student from the session,
 * the team side re-checks `calls.invite`.
 */

const TEAM_CALL_TOPIC = "1:1 with the batch0 team";
// A learner's-scholarship call rides the same row (migration 0071).
const SCHOLARSHIP_TOPIC = "Scholarship mentor call";

function revalidate() {
  for (const p of ["/dashboard/calls", "/admin/calls", "/mentor/calls", "/investor/calls"]) {
    revalidatePath(p);
  }
}

/** Parse the student's proposed times: a preferred one, and an optional backup. */
function proposedTimes(input: { preferredAt: string; altAt?: string | null }, now: Date) {
  const preferredAt = new Date(input.preferredAt);
  if (Number.isNaN(preferredAt.getTime())) refuse("Pick a time that works for you.");
  if (preferredAt.getTime() < now.getTime()) refuse("Pick a time in the future.");
  let altAt: Date | null = null;
  if (input.altAt) {
    altAt = new Date(input.altAt);
    if (Number.isNaN(altAt.getTime())) refuse("That backup time isn't valid.");
    if (altAt.getTime() < now.getTime()) refuse("Your backup time is in the past.");
  }
  return { preferredAt, altAt };
}

/** A student asks the team for a 1:1. */
export async function requestInterview(input: {
  preferredAt: string;
  altAt?: string | null;
  note?: string | null;
}): Promise<ActionResult<{ id: string }>> {
  return runAction({ name: "requestInterview" }, async () => {
    const actor = await requireActor();
    const access = await getStudentAccess(actor.role);
    if (actor.role !== "student" || !canRequestTeamCall(access)) {
      refuse("1:1 requests open once you're enrolled.");
    }
    const { preferredAt, altAt } = proposedTimes(input, new Date());
    const note = input.note?.trim() || null;

    const admin = createAdminClient();
    const { data: created, error } = await admin
      .from("interview_requests")
      .insert({
        student_id: actor.userId,
        cohort_id: access.cohortId,
        preferred_at: preferredAt.toISOString(),
        alt_at: altAt ? altAt.toISOString() : null,
        note,
        status: "requested",
      })
      .select("id")
      .single();
    if (error) {
      // interview_requests_one_open_per_student
      if (error.code === "23505") {
        refuse("You already have a request waiting. Withdraw it to ask again.");
      }
      throw new Error(error.message);
    }
    const id = created!.id as string;

    await logAudit({
      action: "interview_request.created",
      targetType: "interview_request",
      targetId: id,
      payload: { preferred_at: preferredAt.toISOString() },
    });

    // Fan out to the team so the ask isn't waiting on whoever opens the queue.
    try {
      const { data: me } = await admin
        .from("profiles")
        .select("full_name")
        .eq("id", actor.userId)
        .maybeSingle();
      const name = (me as any)?.full_name || "A student";
      const teamIds = await listInterviewTeamIds();
      await notifyMany(
        teamIds
          .filter((uid) => uid !== actor.userId)
          .map((uid) => ({
            userId: uid,
            type: "interview_requested",
            title: `${name} asked for a 1:1`,
            body: note || "Book a time from 1:1 calls.",
            link: "/admin/calls",
            dedupeKey: `interview_requested:${id}:${uid}`,
          })),
      );
    } catch (err) {
      console.error("[interview] request notify failed", err);
    }

    revalidate();
    return { id };
  });
}

/** A student withdraws their own open request. */
export async function cancelInterviewRequest(id: string): Promise<ActionResult> {
  return runAction({ name: "cancelInterviewRequest" }, async () => {
    const actor = await requireActor();
    const admin = createAdminClient();
    const { data: updated, error } = await admin
      .from("interview_requests")
      .update({ status: "cancelled" })
      .eq("id", id)
      // Owner and state in the WHERE clause: nobody else's, and only while open.
      .eq("student_id", actor.userId)
      .eq("status", "requested")
      .select("id");
    if (error) throw new Error(error.message);
    if (!updated || updated.length === 0) {
      refuse("That request was already booked or withdrawn.");
    }
    await logAudit({
      action: "interview_request.cancelled",
      targetType: "interview_request",
      targetId: id,
    });
    revalidate();
  });
}

type ScheduleInput = {
  id: string;
  startsAt: string;
  durationMinutes: number;
  /** Other staff on the call. See createInvite. */
  cohostIds?: string[];
};

/**
 * The team books a time for a request: writes the call (status `invited`,
 * joinable with no accept step) and links the two. Whoever books it hosts,
 * and may put others from the team on it — a scholarship mentor call is
 * usually booked by an admin for the mentor who takes it.
 */
export async function scheduleInterviewRequest(
  input: ScheduleInput,
): Promise<ActionResult<{ callInviteId: string }>> {
  return runAction({ name: "scheduleInterviewRequest" }, () => scheduleNow(input));
}

async function scheduleNow(input: ScheduleInput): Promise<{ callInviteId: string }> {
  const actor = await assertPermission("calls.invite");
  const admin = createAdminClient();

  const req = await getInterviewRequest(input.id);
  if (!req) refuse("That request no longer exists.");
  if (req.status !== "requested") refuse("That request has already been handled.");

  const startsAt = new Date(input.startsAt);
  const timeProblem = callStartProblem(startsAt);
  if (timeProblem) refuse(timeProblem);
  const durationProblem = callDurationProblem(input.durationMinutes);
  if (durationProblem) refuse(durationProblem);
  const duration = Math.round(input.durationMinutes);

  // Tolerant: null on a database without 0071, which is an ordinary request.
  const scholarshipAppId = await scholarshipApplicationIdForRequest(admin, req.id);
  const topic = scholarshipAppId ? SCHOLARSHIP_TOPIC : TEAM_CALL_TOPIC;

  const cohosts = await resolveCohosts(admin, input.cohostIds, {
    hostId: actor.userId,
    inviteeId: req.studentId,
  });

  const { data: invite, error: inviteErr } = await admin
    .from("call_invites")
    .insert({
      host_id: actor.userId,
      invitee_id: req.studentId,
      starts_at: startsAt.toISOString(),
      duration_minutes: duration,
      topic,
      status: "invited",
    })
    .select("id")
    .single();
  if (inviteErr) {
    if (inviteErr.code === "23505") refuse("You already have a call with them at that time.");
    throw new Error(inviteErr.message);
  }
  const inviteId = invite!.id as string;

  // Before the request is claimed, so undoing a failure is deleting the call.
  try {
    await attachCohosts(admin, inviteId, cohosts);
  } catch (err) {
    await admin.from("call_invites").delete().eq("id", inviteId);
    throw err;
  }

  const { data: claimed, error: updErr } = await admin
    .from("interview_requests")
    .update({ status: "scheduled", call_invite_id: inviteId, handled_by: actor.userId })
    .eq("id", req.id)
    // Two people booking at once: the second claims nothing.
    .eq("status", "requested")
    .select("id");
  if (updErr || !claimed || claimed.length === 0) {
    await admin.from("call_invites").delete().eq("id", inviteId);
    throw new Error(updErr?.message ?? "Someone else just handled that request.");
  }

  // A scholarship call spends its credit HERE, not when the student asked.
  // Conditional on a credit being left, so concurrent bookings can't overspend.
  if (scholarshipAppId && !(await spendCallCredit(admin, scholarshipAppId))) {
    console.warn("[interview] scholarship credit not spent (none left or award gone)", {
      requestId: req.id,
      scholarshipAppId,
    });
  }

  await logAudit({
    action: "interview_request.scheduled",
    targetType: "interview_request",
    targetId: req.id,
    payload: {
      call_invite_id: inviteId,
      starts_at: startsAt.toISOString(),
      scholarship_application_id: scholarshipAppId,
      cohost_ids: cohosts.map((c) => c.id),
    },
  });

  try {
    const { data: hostProfile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", actor.userId)
      .maybeSingle();
    const hostName = (hostProfile as any)?.full_name || "The batch0 team";
    await notify({
      userId: req.studentId,
      type: "call_invited",
      title: "Your 1:1 with the team is booked",
      body: `${formatEasternDateTime(startsAt) ?? startsAt.toISOString()} · ${duration} min`,
      link: "/dashboard/calls",
    });
    await notifyCohostsAdded(cohosts, { hostName, studentName: req.studentName, topic });
    if (req.studentEmail) {
      const t = Templates.callInvite({
        inviteId,
        hostName,
        startsAt: startsAt.toISOString(),
        durationMinutes: duration,
        topic,
        alsoJoining: cohosts.map((c) => c.name),
      });
      await sendEmail({ to: req.studentEmail, subject: t.subject, html: t.html });
    }
  } catch (err) {
    console.error("[interview] schedule notify failed", err);
  }

  revalidate();
  return { callInviteId: inviteId };
}

/** The team turns a request down; the student can ask again with other times. */
export async function declineInterviewRequest(id: string): Promise<ActionResult> {
  return runAction({ name: "declineInterviewRequest" }, async () => {
    const actor = await assertPermission("calls.invite");
    const admin = createAdminClient();
    const req = await getInterviewRequest(id);
    if (!req) refuse("That request no longer exists.");

    const { data: updated, error } = await admin
      .from("interview_requests")
      .update({ status: "declined", handled_by: actor.userId })
      .eq("id", id)
      .eq("status", "requested")
      .select("id");
    if (error) throw new Error(error.message);
    if (!updated || updated.length === 0) refuse("That request has already been handled.");

    await logAudit({
      action: "interview_request.declined",
      targetType: "interview_request",
      targetId: id,
    });
    await notify({
      userId: req.studentId,
      type: "interview_declined",
      title: "We couldn't book your 1:1",
      body: "Ask again with other times whenever suits you.",
      link: "/dashboard/calls",
    });
    revalidate();
  });
}
