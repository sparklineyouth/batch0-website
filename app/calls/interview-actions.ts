"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { getStudentAccess } from "@/lib/access";
import {
  getInterviewRequest,
  listInterviewTeamIds,
} from "@/lib/interview-requests";
import { logAudit } from "@/lib/audit";
import {
  spendCallCredit,
  scholarshipApplicationIdForRequest,
} from "@/lib/scholarships";
import { notify, notifyMany } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";

/**
 * Server actions for "getting to know you" interview requests (migration
 * 0061). The student-first counterpart to app/calls/actions.ts.
 *
 * Same discipline as its sibling: every mutation re-checks authorization
 * here, because a server action is its own entry point. The student side
 * re-derives the student from the session; the team side re-checks
 * `calls.invite`.
 */

const INTERVIEW_TOPIC = "Getting to know you";
// A learner's-scholarship call rides the same request row and the same action
// (migration 0071), but it is a mentor call during the cohort, not an
// onboarding interview — and labelling it "Getting to know you" on both
// people's calendars told the mentor the wrong thing about why they were there.
const SCHOLARSHIP_TOPIC = "Scholarship mentor call";

// The interview request card lives on these three surfaces (the calls page,
// the dashboard home, and the enrolled page), plus the team's queue on
// /admin/calls. Revalidate all of them after any change so a request never
// looks unanswered on one page and handled on another.
const STUDENT_PATHS = ["/dashboard", "/dashboard/calls", "/dashboard/enrolled"];
const TEAM_PATHS = ["/admin/calls", "/mentor/calls", "/investor/calls"];

function revalidateStudent() {
  for (const p of STUDENT_PATHS) revalidatePath(p);
}
function revalidateTeam() {
  for (const p of TEAM_PATHS) revalidatePath(p);
}

/** A student asks the team for an interview. */
export async function requestInterview(input: {
  preferredAt: string;
  altAt?: string | null;
  note?: string | null;
}) {
  const actor = await requireActor();

  // The feature is a pre-kickoff onboarding step, so it's for students, and
  // only while their cohort hasn't started. getStudentAccess resolves both
  // the gate and the cohort id the row records — one request-cached read.
  const access = await getStudentAccess(actor.role);
  if (actor.role !== "student" || access.staff) {
    throw new Error("Only students can request an interview.");
  }
  if (!access.enrolled) {
    throw new Error("Interview requests open once you're enrolled.");
  }
  if (!access.preCohort) {
    throw new Error(
      "Interview requests are for before kickoff — your cohort is already underway.",
    );
  }

  const preferredAt = new Date(input.preferredAt);
  if (Number.isNaN(preferredAt.getTime())) {
    throw new Error("That preferred time isn't valid.");
  }
  if (preferredAt.getTime() < Date.now()) {
    throw new Error("Pick a time in the future.");
  }
  let altAt: Date | null = null;
  if (input.altAt) {
    altAt = new Date(input.altAt);
    if (Number.isNaN(altAt.getTime())) {
      throw new Error("That alternate time isn't valid.");
    }
    if (altAt.getTime() < Date.now()) {
      throw new Error("Your alternate time is in the past.");
    }
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("interview_requests")
    .insert({
      student_id: actor.userId,
      cohort_id: access.cohortId,
      preferred_at: preferredAt.toISOString(),
      alt_at: altAt ? altAt.toISOString() : null,
      note: input.note?.trim() || null,
      status: "requested",
    })
    .select("id")
    .single();

  if (error) {
    // The partial unique index (one open request per student) fires here.
    if (error.code === "23505") {
      throw new Error("You've already got an open interview request.");
    }
    throw new Error(error.message);
  }

  const id = created!.id;

  await logAudit({
    action: "interview_request.created",
    targetType: "interview_request",
    targetId: id,
    payload: { preferred_at: preferredAt.toISOString() },
  });

  // Fan the ask out to the whole team, so it isn't waiting on whoever next
  // happens to open the queue. Best-effort.
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
          title: `${name} requested a getting-to-know-you interview`,
          body: input.note?.trim() || "Schedule it from 1:1 calls.",
          link: "/admin/calls",
          // One notification per team member per request — a re-render or a
          // retry shouldn't stack duplicates in anyone's bell.
          dedupeKey: `interview_requested:${id}:${uid}`,
        })),
    );
  } catch (err) {
    console.error("[interview] request notify failed", err);
  }

  revalidateStudent();
  revalidateTeam();
  return { id };
}

/** A student withdraws their own open request. */
export async function cancelInterviewRequest(id: string) {
  const actor = await requireActor();
  const admin = createAdminClient();

  const { data: req } = await admin
    .from("interview_requests")
    .select("id, student_id, status")
    .eq("id", id)
    .maybeSingle();
  if (!req) throw new Error("That request no longer exists.");
  if ((req as any).student_id !== actor.userId) throw new Error("Forbidden");
  if ((req as any).status !== "requested") {
    throw new Error("That request has already been handled.");
  }

  const { error } = await admin
    .from("interview_requests")
    .update({ status: "cancelled" })
    .eq("id", id)
    // Re-assert the owner in the WHERE clause, so a future refactor that loses
    // the check above still can't cancel someone else's request.
    .eq("student_id", actor.userId);
  if (error) throw new Error(error.message);

  await logAudit({
    action: "interview_request.cancelled",
    targetType: "interview_request",
    targetId: id,
  });

  revalidateStudent();
  revalidateTeam();
}

/**
 * The team confirms a time. Writes a real call_invites row and links the two,
 * so the meeting itself runs on the existing 1:1 machinery.
 */
export async function scheduleInterviewRequest(input: {
  id: string;
  startsAt: string;
  durationMinutes: number;
}) {
  const actor = await assertPermission("calls.invite");
  const admin = createAdminClient();

  const req = await getInterviewRequest(input.id);
  if (!req) throw new Error("That request no longer exists.");
  if (req.status !== "requested") {
    throw new Error("That request has already been handled.");
  }

  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw new Error("That time isn't valid.");
  if (startsAt.getTime() < Date.now()) throw new Error("That time is in the past.");
  const duration = Math.round(input.durationMinutes);
  if (duration < 5 || duration > 240) {
    throw new Error("Calls run between 5 and 240 minutes.");
  }

  // Read before the insert so the call carries the right topic. Tolerant (see
  // lib/scholarships.ts): null on a database where 0071 hasn't run, which is
  // simply an ordinary interview.
  const scholarshipAppId = await scholarshipApplicationIdForRequest(admin, req.id);
  const topic = scholarshipAppId ? SCHOLARSHIP_TOPIC : INTERVIEW_TOPIC;

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
    if (inviteErr.code === "23505") {
      throw new Error("You've already invited them to that time.");
    }
    throw new Error(inviteErr.message);
  }

  const inviteId = invite!.id;

  const { error: updErr } = await admin
    .from("interview_requests")
    .update({
      status: "scheduled",
      call_invite_id: inviteId,
      handled_by: actor.userId,
    })
    .eq("id", req.id)
    // Only claim a request that's still open, so two staff scheduling at once
    // can't both win — the second update touches zero rows.
    .eq("status", "requested");
  if (updErr) {
    // Roll back the invite we just wrote so a failed link doesn't leave an
    // orphan call the student never asked for at this exact time.
    await admin.from("call_invites").delete().eq("id", inviteId);
    throw new Error(updErr.message);
  }

  // A learner's-scholarship call spends one credit — HERE, not when the
  // student asked. A request the team never picks up costs them nothing, which
  // is the only fair reading of a grant of "three calls". spendCallCredit is
  // conditional on a credit being left, so two staff scheduling the same
  // student's requests at once can't overspend the grant.
  //
  // Read tolerantly (see lib/scholarships.ts) so this whole block is a no-op on
  // a database where 0071 hasn't run, rather than breaking the ordinary
  // getting-to-know-you interview it shares an action with.
  if (scholarshipAppId) {
    const spent = await spendCallCredit(admin, scholarshipAppId);
    if (!spent) {
      // Out of credits, or the award was revoked between request and schedule.
      // The call still happens — it is booked, and un-booking it over an
      // accounting detail would be worse for the student and the mentor than
      // letting the balance read zero. Logged so it is visible.
      console.warn(
        "[interview] scholarship credit not spent (none left or award gone)",
        { requestId: req.id, scholarshipAppId },
      );
    }
  }

  await logAudit({
    action: "interview_request.scheduled",
    targetType: "interview_request",
    targetId: req.id,
    payload: {
      call_invite_id: inviteId,
      starts_at: startsAt.toISOString(),
      scholarship_application_id: scholarshipAppId,
    },
  });

  // Tell the student, both in-app and by email — same shape as a staff-sent
  // invite, because to them it now is one.
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
      title: scholarshipAppId
        ? "Your scholarship mentor call is booked"
        : "Your getting-to-know-you interview is booked",
      body: "Open your 1:1 calls to accept the time.",
      link: "/dashboard/calls",
    });

    if (req.studentEmail) {
      const t = Templates.callInvite({
        hostName,
        startsAt: startsAt.toISOString(),
        durationMinutes: duration,
        topic,
      });
      await sendEmail({ to: req.studentEmail, subject: t.subject, html: t.html });
    }
  } catch (err) {
    console.error("[interview] schedule notify failed", err);
  }

  revalidateStudent();
  revalidateTeam();
  return { callInviteId: inviteId };
}

/** The team turns a request down. */
export async function declineInterviewRequest(id: string) {
  const actor = await assertPermission("calls.invite");
  const admin = createAdminClient();

  const { data: req } = await admin
    .from("interview_requests")
    .select("id, student_id, status")
    .eq("id", id)
    .maybeSingle();
  if (!req) throw new Error("That request no longer exists.");
  if ((req as any).status !== "requested") {
    throw new Error("That request has already been handled.");
  }

  const { error } = await admin
    .from("interview_requests")
    .update({ status: "declined", handled_by: actor.userId })
    .eq("id", id)
    .eq("status", "requested");
  if (error) throw new Error(error.message);

  await logAudit({
    action: "interview_request.declined",
    targetType: "interview_request",
    targetId: id,
  });

  try {
    await notify({
      userId: (req as any).student_id,
      type: "interview_declined",
      title: "About your interview request",
      body: "We couldn't schedule your getting-to-know-you interview this time. You can ask again.",
      link: "/dashboard/calls",
    });
  } catch (err) {
    console.error("[interview] decline notify failed", err);
  }

  revalidateStudent();
  revalidateTeam();
}
