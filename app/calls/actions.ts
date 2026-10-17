"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { refuse, runAction, type ActionResult } from "@/lib/action-result";
import { notify, notifyMany } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { can } from "@/lib/permissions";
import { notifyCallChanged } from "@/lib/live-rooms";
import {
  addCohostRows,
  attachCohosts,
  notifyCohostsAdded,
  readCohostIds,
  refundScholarshipCreditFor,
  resolveCohosts,
  staffCallsHref,
} from "@/lib/calls";
import {
  callStaffIds,
  isOnCall,
  isStaffOnCall,
  joinNames,
  MAX_CALL_COHOSTS,
  type CallInviteStatus,
} from "@/lib/live";
import {
  callDurationProblem,
  callListPhase,
  callPhase,
  callStartProblem,
  canAddCallCohosts,
  canCancelCall,
  canDeclineCall,
  canEditCall,
  canMarkCallCompleted,
  cohostsToAdd,
  formatEasternDateTime,
  startOfMinute,
  type CallPhase,
  type CallTiming,
} from "@/lib/call-lifecycle";

/**
 * Server actions for 1:1 calls, shared by /admin/calls, /mentor/calls,
 * /investor/calls and the student's /dashboard/calls. Every mutation
 * re-checks authorization here (a server action is its own entry point),
 * writes through the service role, and answers with an ActionResult so the
 * person sees the real reason when something is refused.
 *
 * A rule saying no ("That time is in the past.") is `refuse(...)`, which
 * reaches the form the same way but stays out of the error log; only a
 * database failure is a thrown Error (lib/action-result.ts).
 */

const PATHS = ["/dashboard/calls", "/mentor/calls", "/investor/calls", "/admin/calls"];

function revalidateAll() {
  for (const p of PATHS) revalidatePath(p);
}

type Admin = ReturnType<typeof createAdminClient>;

const ROW = "id, host_id, invitee_id, status, topic, starts_at, duration_minutes";

function timingOf(row: any): CallTiming {
  return {
    status: row.status as CallInviteStatus,
    startsAt: row.starts_at,
    durationMinutes: row.duration_minutes,
  };
}

async function readCall(admin: Admin, id: string): Promise<any> {
  if (typeof id !== "string" || !id) refuse("That call no longer exists.");
  const { data, error } = await admin.from("call_invites").select(ROW).eq("id", id).maybeSingle();
  // A malformed id (22P02) is "no such call"; any other failure is not.
  if (error && error.code !== "22P02") {
    console.error("[calls] read failed", error.message);
    throw new Error("Couldn't load that call. Try again in a moment.");
  }
  if (!data) refuse("That call no longer exists.");
  return data;
}

/** The row plus its co-hosts, as `isOnCall` / `isStaffOnCall` decide on. */
async function partiesOf(admin: Admin, row: any) {
  const cohostIds = await readCohostIds(admin, row.id);
  return {
    hostId: row.host_id as string,
    inviteeId: row.invitee_id as string,
    cohosts: cohostIds.map((id) => ({ id })),
  };
}

/** Host and student are answered from the row; only anyone else costs a read. */
async function onCall(admin: Admin, row: any, userId: string): Promise<boolean> {
  if (row.host_id === userId || row.invitee_id === userId) return true;
  return isOnCall(await partiesOf(admin, row), userId);
}

async function namesOf(admin: Admin, ids: readonly string[]): Promise<Map<string, string | null>> {
  const { data } = await admin.from("profiles").select("id, full_name").in("id", [...ids]);
  return new Map(((data ?? []) as any[]).map((r) => [r.id as string, r.full_name ?? null]));
}

/** Bell everyone on the staff side but `except`, each linked to their own calls page. */
async function notifyStaff(
  admin: Admin,
  staffIds: readonly string[],
  except: string,
  note: { type: string; title: string; body: string | null },
): Promise<void> {
  const ids = staffIds.filter((id) => id !== except);
  if (ids.length === 0) return;
  const { data } = await admin.from("profiles").select("id, role").in("id", ids);
  const roles = new Map(((data ?? []) as any[]).map((r) => [r.id as string, r.role ?? null]));
  const links = await Promise.all(ids.map((id) => staffCallsHref(roles.get(id))));
  await notifyMany(ids.map((userId, i) => ({ userId, ...note, link: links[i] })));
}

function whenLine(startsAt: string, durationMinutes: number): string {
  return `${formatEasternDateTime(startsAt) ?? startsAt} · ${durationMinutes} min`;
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

type InviteInput = {
  inviteeId: string;
  /** Ignored when `startNow`: the server starts it on the current minute. */
  startsAt?: string;
  startNow?: boolean;
  durationMinutes: number;
  topic: string;
  /** Others from the team on the call (migration 0092). */
  cohostIds?: string[];
};

/**
 * Book a call with a student, or start one now. No accept step: the student
 * gets a bell and an email with the Join link, and may decline.
 */
export async function createInvite(
  input: InviteInput,
): Promise<ActionResult<{ id: string }>> {
  return runAction({ name: "createInvite" }, () => createInviteNow(input));
}

async function createInviteNow(input: InviteInput): Promise<{ id: string }> {
  // The capability, not the role: an admin can grant calls.invite to any role.
  const actor = await assertPermission("calls.invite");
  const admin = createAdminClient();

  const now = new Date();
  const startsAt = input.startNow ? startOfMinute(now) : new Date(input.startsAt ?? "");
  const timeProblem = callStartProblem(startsAt, now);
  if (timeProblem) refuse(timeProblem);
  const durationProblem = callDurationProblem(input.durationMinutes);
  if (durationProblem) refuse(durationProblem);
  const duration = Math.round(input.durationMinutes);
  const topic = (input.topic ?? "").trim() || null;

  // The picker only offers students, but the picker is not the boundary.
  const { data: invitee } = await admin
    .from("profiles")
    .select("id, role, email, full_name")
    .eq("id", input.inviteeId)
    .maybeSingle();
  if (!invitee || (invitee as any).role !== "student") {
    refuse("You can only invite students.");
  }
  if ((invitee as any).id === actor.userId) refuse("You can't invite yourself.");

  const cohosts = await resolveCohosts(admin, input.cohostIds, {
    hostId: actor.userId,
    inviteeId: input.inviteeId,
  });

  const { data: created, error } = await admin
    .from("call_invites")
    .insert({
      host_id: actor.userId,
      invitee_id: input.inviteeId,
      starts_at: startsAt.toISOString(),
      duration_minutes: duration,
      topic,
      status: "invited",
    })
    .select("id")
    .single();
  if (error) {
    // Unique (host_id, invitee_id, starts_at): a double-submit.
    if (error.code === "23505") refuse("You already have a call with them at that time.");
    throw new Error(error.message);
  }
  const id = created!.id as string;

  try {
    await attachCohosts(admin, id, cohosts);
  } catch (err) {
    // Never leave a call missing half its people; nothing has been sent yet.
    await admin.from("call_invites").delete().eq("id", id);
    throw err;
  }

  await logAudit({
    action: "call_invite.created",
    targetType: "call_invite",
    targetId: id,
    payload: {
      invitee_id: input.inviteeId,
      starts_at: startsAt.toISOString(),
      start_now: !!input.startNow,
      cohost_ids: cohosts.map((c) => c.id),
    },
  });

  // Best-effort: the call exists and is on their calls page either way.
  try {
    const hostName = (await namesOf(admin, [actor.userId])).get(actor.userId) || "Someone from batch0";
    await notify({
      userId: input.inviteeId,
      type: "call_invited",
      title: input.startNow
        ? `${hostName} is starting a 1:1 with you now`
        : `${hostName} booked a 1:1 with you`,
      body: topic ?? whenLine(startsAt.toISOString(), duration),
      link: input.startNow ? `/dashboard/calls/${id}/live` : "/dashboard/calls",
    });
    await notifyCohostsAdded(cohosts, {
      hostName,
      studentName: (invitee as any).full_name || "a student",
      topic,
    });
    const email = (invitee as any).email as string | null;
    if (email) {
      const t = Templates.callInvite({
        inviteId: id,
        hostName,
        startsAt: startsAt.toISOString(),
        durationMinutes: duration,
        topic,
        alsoJoining: cohosts.map((c) => c.name),
        startingNow: !!input.startNow,
      });
      await sendEmail({ to: email, subject: t.subject, html: t.html });
    }
  } catch (err) {
    console.error("[calls] invite notify failed", err);
  }

  revalidateAll();
  return { id };
}

type UpdateInput = {
  id: string;
  startsAt: string;
  durationMinutes: number;
  topic: string;
};

/**
 * Move a call, change its length or its topic. The staff side or an admin,
 * while the call can still happen. A new time goes back to `invited`, so the
 * student can decline it if it doesn't work; they hear about it either way.
 */
export async function updateInvite(input: UpdateInput): Promise<ActionResult<{ changed: boolean }>> {
  return runAction({ name: "updateInvite" }, () => updateInviteNow(input));
}

async function updateInviteNow(input: UpdateInput): Promise<{ changed: boolean }> {
  const actor = await requireActor();
  const admin = createAdminClient();
  const row = await readCall(admin, input.id);
  const parties = await partiesOf(admin, row);
  if (!isStaffOnCall(parties, actor.userId) && !actor.caps.superAdmin) {
    refuse("Only the people running this call can change it.");
  }
  if (!canEditCall(timingOf(row))) {
    refuse(whyNotActive(callListPhase(timingOf(row), new Date(), "staff"), "changed"));
  }

  const startsAt = new Date(input.startsAt);
  const oldStart = new Date(row.starts_at);
  const moved = startOfMinute(startsAt).getTime() !== startOfMinute(oldStart).getTime();
  // An unchanged time is never "in the past" — editing the topic of a call
  // that is running must not fail on its own start.
  if (moved) {
    const problem = callStartProblem(startsAt);
    if (problem) refuse(problem);
  } else if (Number.isNaN(startsAt.getTime())) {
    refuse("That time isn't valid.");
  }
  const durationProblem = callDurationProblem(input.durationMinutes);
  if (durationProblem) refuse(durationProblem);
  const duration = Math.round(input.durationMinutes);
  const topic = (input.topic ?? "").trim() || null;
  const resized = duration !== row.duration_minutes;
  const retitled = topic !== (row.topic ?? null);
  if (!moved && !resized && !retitled) return { changed: false };

  const nextStart = moved ? startsAt.toISOString() : row.starts_at;
  const { data: updated, error } = await admin
    .from("call_invites")
    .update({
      starts_at: nextStart,
      duration_minutes: duration,
      topic,
      ...(moved ? { status: "invited" } : {}),
    })
    .eq("id", row.id)
    .in("status", ["invited", "accepted"])
    .select("id");
  if (error) {
    if (error.code === "23505") refuse("There's already a call with them at that time.");
    throw new Error(error.message);
  }
  if (!updated || updated.length === 0) {
    refuse("That call was cancelled, declined or ended in the meantime.");
  }

  await logAudit({
    action: "call_invite.updated",
    targetType: "call_invite",
    targetId: row.id,
    payload: {
      from: { starts_at: row.starts_at, duration_minutes: row.duration_minutes, topic: row.topic },
      to: { starts_at: nextStart, duration_minutes: duration, topic },
    },
  });

  await notifyCallChanged(row.id);

  try {
    const [names, { data: student }] = await Promise.all([
      namesOf(admin, [actor.userId, parties.inviteeId]),
      admin.from("profiles").select("email").eq("id", parties.inviteeId).maybeSingle(),
    ]);
    const who = names.get(actor.userId) || "Someone from batch0";
    const studentName = names.get(parties.inviteeId) || "a student";
    const when = whenLine(nextStart, duration);
    await notify({
      userId: parties.inviteeId,
      type: "call_updated",
      title: moved || resized ? `${who} moved your 1:1` : `${who} updated your 1:1`,
      body: topic ? `${when} · ${topic}` : when,
      link: "/dashboard/calls",
    });
    await notifyStaff(admin, callStaffIds(parties), actor.userId, {
      type: "call_updated",
      title: `${who} changed the 1:1 with ${studentName}`,
      body: when,
    });
    const email = (student as any)?.email as string | null;
    if (email && (moved || resized)) {
      const t = Templates.callUpdated({
        inviteId: row.id,
        changedBy: who,
        startsAt: nextStart,
        durationMinutes: duration,
        topic,
      });
      await sendEmail({ to: email, subject: t.subject, html: t.html });
    }
  } catch (err) {
    console.error("[calls] update notify failed", err);
  }

  revalidateAll();
  return { changed: true };
}

// ---------------------------------------------------------------------------
// People on the call
// ---------------------------------------------------------------------------

/**
 * Add people from the team to a call that already exists. Anyone on the
 * call's staff side, or a holder of calls.join_any (admins) — never the
 * student. Who may BE added is who may host calls (resolveCohosts), held to
 * MAX_CALL_COHOSTS on the call's total; anyone already on it is skipped.
 * The student is always told who is coming (safeguarding).
 */
export async function addCallCohosts(
  inviteId: string,
  cohostIds: string[],
): Promise<ActionResult<{ added: string[] }>> {
  return runAction({ name: "addCallCohosts" }, () => addCallCohostsNow(inviteId, cohostIds));
}

async function addCallCohostsNow(
  inviteId: string,
  cohostIds: string[],
): Promise<{ added: string[] }> {
  const actor = await requireActor();
  const admin = createAdminClient();
  const row = await readCall(admin, inviteId);

  // Throws on a failed co-host read rather than answering "nobody".
  const parties = await partiesOf(admin, row);
  const onStaff = isStaffOnCall(parties, actor.userId);
  const joiningAny = actor.userId !== parties.inviteeId && can(actor.caps, "calls.join_any");
  if (!onStaff && !joiningAny) {
    refuse("You're not on this call, so you can't add anyone to it.");
  }
  if (!canAddCallCohosts(timingOf(row))) {
    refuse(whyNotActive(callListPhase(timingOf(row), new Date(), "staff"), "joined"));
  }

  const plan = cohostsToAdd(Array.isArray(cohostIds) ? cohostIds : [], parties);
  if (plan.ids.length === 0) return { added: [] };
  if (!plan.fits) {
    refuse(
      plan.room === 0
        ? `This call already has ${MAX_CALL_COHOSTS} from the team besides its host.`
        : `This call has room for ${plan.room} more from the team.`,
    );
  }

  const cohosts = await resolveCohosts(admin, plan.ids, parties, "existing");
  const added = await addCohostRows(admin, row.id, cohosts);
  if (added.length === 0) return { added: [] };

  await logAudit({
    action: "call_invite.cohosts_added",
    targetType: "call_invite",
    targetId: row.id,
    payload: {
      cohost_ids: added.map((c) => c.id),
      // Someone not on the call put people on it: the override an audit of a
      // programme of minors has to be able to find.
      ...(onStaff ? {} : { via: "calls.join_any" }),
    },
  });

  // Anyone already in the room picks up the new people now, not next heartbeat.
  await notifyCallChanged(row.id);

  const joining = joinNames(added.map((c) => c.name));
  const topic = (row.topic as string | null) || null;

  // The student first, on its own: of everything here, this must arrive.
  await notify({
    userId: parties.inviteeId,
    type: "call_invited",
    title: `${joining} will also join your 1:1`,
    body: topic,
    link: "/dashboard/calls",
  });

  try {
    const names = await namesOf(admin, [actor.userId, parties.hostId, parties.inviteeId]);
    const hostName = names.get(parties.hostId) || "Someone from batch0";
    const studentName = names.get(parties.inviteeId) || "a student";
    await notifyStaff(admin, callStaffIds(parties), actor.userId, {
      type: "call_invited",
      title: `${joining} will also join your 1:1 with ${studentName}`,
      body: topic,
    });
    await notifyCohostsAdded(
      added.filter((c) => c.id !== actor.userId),
      {
        hostName,
        studentName,
        topic,
        addedByName:
          actor.userId === parties.hostId ? null : names.get(actor.userId) || "Someone on the team",
      },
    );
  } catch (err) {
    console.error("[calls] add-people notify failed", err);
  }

  revalidateAll();
  return { added: added.map((c) => c.id) };
}

/** Why a call can't be changed or joined any more, in the card's words. */
function whyNotActive(phase: CallPhase, verb: "changed" | "joined"): string {
  if (phase === "cancelled") return "That call was cancelled.";
  if (phase === "declined") return "The student declined that call.";
  return verb === "changed"
    ? "That call is already over."
    : "That call is already over, so nobody can be added to it.";
}

// ---------------------------------------------------------------------------
// Declining, cancelling, ending
// ---------------------------------------------------------------------------

/**
 * The student can't make it — until the call starts (canDeclineCall). Invitee
 * only; co-hosts never answer for them. Hands back a scholarship credit.
 */
export async function declineInvite(id: string): Promise<ActionResult> {
  return runAction({ name: "declineInvite" }, async () => {
    const actor = await requireActor();
    const admin = createAdminClient();
    const row = await readCall(admin, id);
    if (row.invitee_id !== actor.userId) refuse("Only the student on a call can decline it.");
    const phase = callPhase(timingOf(row));
    if (!canDeclineCall(timingOf(row))) {
      refuse(
        phase === "declined"
          ? "You already declined that call."
          : phase === "live"
            ? "That call has already started."
            : whyNotActive(phase, "changed"),
      );
    }

    const { data: updated, error } = await admin
      .from("call_invites")
      .update({ status: "declined" })
      .eq("id", row.id)
      .eq("invitee_id", actor.userId)
      // A decline racing a cancel: exactly one wins, so the refund runs once.
      .in("status", ["invited", "accepted"])
      // And never once it has started, whatever the clock said a moment ago.
      .gt("starts_at", new Date().toISOString())
      .select("id");
    if (error) throw new Error(error.message);
    if (!updated || updated.length === 0) {
      refuse("That call has started or was changed. Reload to see it.");
    }

    await refundScholarshipCreditFor(admin, row.id);
    await logAudit({ action: "call_invite.declined", targetType: "call_invite", targetId: row.id });
    await notifyCallChanged(row.id);

    try {
      const staff = [row.host_id as string, ...(await readCohostIds(admin, row.id))];
      const me = (await namesOf(admin, [actor.userId])).get(actor.userId) || "A student";
      await notifyStaff(admin, staff, actor.userId, {
        type: "call_response",
        title: `${me} can't make your 1:1`,
        body: row.topic || whenLine(row.starts_at, row.duration_minutes),
      });
    } catch (err) {
      console.error("[calls] decline notify failed", err);
    }

    revalidateAll();
  });
}

/**
 * Cancel. The staff side or a superAdmin, until shortly after the scheduled
 * end (canCancelCall) — including while live, for a host giving up on a
 * no-show. Hands back a scholarship credit, and closes the room for anyone in
 * it.
 */
export async function cancelInvite(id: string): Promise<ActionResult> {
  return runAction({ name: "cancelInvite" }, async () => {
    const actor = await requireActor();
    const admin = createAdminClient();
    const row = await readCall(admin, id);
    const parties = await partiesOf(admin, row);
    if (!isStaffOnCall(parties, actor.userId) && !actor.caps.superAdmin) {
      refuse("Only the people running this call can cancel it.");
    }
    if (!canCancelCall(timingOf(row))) {
      refuse(whyNotActive(callListPhase(timingOf(row), new Date(), "staff"), "changed"));
    }

    const { data: updated, error } = await admin
      .from("call_invites")
      .update({ status: "cancelled" })
      .eq("id", row.id)
      // Two cancels (or a cancel and a decline) racing: the refund runs once.
      .in("status", ["invited", "accepted"])
      .select("id");
    if (error) throw new Error(error.message);
    if (!updated || updated.length === 0) refuse("That call was already changed.");

    await refundScholarshipCreditFor(admin, row.id);
    await logAudit({ action: "call_invite.cancelled", targetType: "call_invite", targetId: row.id });
    await notifyCallChanged(row.id);

    try {
      const names = await namesOf(admin, [actor.userId, parties.inviteeId]);
      const who = names.get(actor.userId) || "Someone on the team";
      const studentName = names.get(parties.inviteeId) || "a student";
      const body = row.topic || whenLine(row.starts_at, row.duration_minutes);
      if (parties.inviteeId !== actor.userId) {
        await notify({
          userId: parties.inviteeId,
          type: "call_cancelled",
          title: "A 1:1 call was cancelled",
          body,
          link: "/dashboard/calls",
        });
      }
      await notifyStaff(admin, callStaffIds(parties), actor.userId, {
        type: "call_cancelled",
        title: `${who} cancelled the 1:1 with ${studentName}`,
        body,
      });
    } catch (err) {
      console.error("[calls] cancel notify failed", err);
    }

    revalidateAll();
  });
}

/**
 * End a call for everyone on it — anyone on the call, from the room. Marks it
 * completed once it has started (canMarkCallCompleted); idempotent.
 *
 * Revalidates NOTHING on purpose: revalidating re-renders the current route,
 * which is the room, and would unmount it while the recording still uploads.
 * The other people learn of the End from `room-changed` (notifyCallChanged)
 * or their next heartbeat.
 */
export async function endCall(id: string): Promise<ActionResult<{ completed: boolean }>> {
  return runAction({ name: "endCall" }, async () => {
    const actor = await requireActor();
    const admin = createAdminClient();
    const row = await readCall(admin, id);
    if (!(await onCall(admin, row, actor.userId))) refuse("You're not on this call.");
    if (row.status === "completed") return { completed: true };
    if (!canMarkCallCompleted(timingOf(row))) return { completed: false };

    const { data: updated, error } = await admin
      .from("call_invites")
      .update({ status: "completed" })
      .eq("id", row.id)
      .in("status", ["invited", "accepted"])
      .select("id");
    if (error) throw new Error(error.message);
    const completed = !!updated && updated.length > 0;
    if (completed) {
      await logAudit({
        action: "call_invite.completed",
        targetType: "call_invite",
        targetId: row.id,
        payload: { ended_by: actor.userId },
      });
      await notifyCallChanged(row.id);
    }
    return { completed };
  });
}

