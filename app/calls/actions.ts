"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";
import { notify, notifyMany } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { can } from "@/lib/permissions";
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
  callPhase,
  canAddCallCohosts,
  canCancelCall,
  canMarkCallCompleted,
  canRespondToCall,
  cohostsToAdd,
  isPastPhase,
  type CallPhase,
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

/**
 * A call_invites row plus its co-hosts, as the parties `isOnCall` /
 * `isStaffOnCall` decide on. Every action below that used to ask "host or
 * invitee?" of the bare row asks of this instead (migration 0092).
 */
async function partiesOf(
  admin: ReturnType<typeof createAdminClient>,
  row: any,
) {
  const cohostIds = await readCohostIds(admin, row.id);
  return {
    hostId: row.host_id as string,
    inviteeId: row.invitee_id as string,
    cohosts: cohostIds.map((id) => ({ id })),
  };
}

/**
 * Is `userId` on this call? The host and the student are answered from the
 * row itself, so the polls they run every few seconds never touch the co-host
 * table; only someone who is neither costs the extra read.
 */
async function onCall(
  admin: ReturnType<typeof createAdminClient>,
  row: any,
  userId: string,
): Promise<boolean> {
  if (row.host_id === userId || row.invitee_id === userId) return true;
  return isOnCall(await partiesOf(admin, row), userId);
}

/** Each staff member's role, for linking them to their own calls page. */
async function rolesOf(
  admin: ReturnType<typeof createAdminClient>,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const { data } = await admin
    .from("profiles")
    .select("id, role")
    .in("id", [...ids]);
  return new Map(
    ((data ?? []) as any[]).map((r) => [r.id as string, r.role ?? null]),
  );
}

type InviteInput = {
  inviteeId: string;
  startsAt: string;
  durationMinutes: number;
  topic: string;
  /**
   * Other staff on the call (migration 0092) — anyone whose role may host
   * calls. A "1:1" is one student and any number of staff; the sender is the
   * host.
   */
  cohostIds?: string[];
};

/**
 * Send an invite. Answers with an ActionResult rather than throwing, because
 * a production build strips a thrown action's message and the form would
 * read "Something went wrong" for every refusal here — the past time, the
 * duplicate, and the co-host ones that say what to change (too many people,
 * someone who cannot host calls, a database still waiting on 0092).
 */
export async function createInvite(
  input: InviteInput,
): Promise<ActionResult<{ id: string }>> {
  return runAction({ name: "createInvite" }, () => createInviteNow(input));
}

async function createInviteNow(input: InviteInput): Promise<{ id: string }> {
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

  // The same rule for co-hosts, checked before anything is written — and on
  // a database without 0092, refused here with a sentence, not after the
  // student has been emailed. See resolveCohosts.
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

  try {
    await attachCohosts(admin, id, cohosts);
  } catch (err) {
    // Don't leave behind a call that's missing half its people — the student
    // would be invited to a meeting that isn't the one planned. Nothing has
    // been sent or audited yet, so deleting the row undoes all of it.
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
      cohost_ids: cohosts.map((c) => c.id),
    },
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

    await notifyCohostsAdded(cohosts, {
      hostName,
      studentName: (invitee as any).full_name || "a student",
      topic: input.topic.trim() || null,
    });

    const email = (invitee as any).email as string | null;
    if (email) {
      const t = Templates.callInvite({
        hostName,
        startsAt: startsAt.toISOString(),
        durationMinutes: duration,
        topic: input.topic.trim() || null,
        alsoJoining: cohosts.map((c) => c.name),
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
 * Add people from the team to a call that already exists: the host bringing
 * a colleague in, a co-host doing the same, or an admin stepping into someone
 * else's call (usually by adding themselves — the observer card's Join call).
 *
 * Who may: anyone on the call's staff side, the same people who may cancel
 * it; or anyone holding calls.join_any, the safeguarding power admins hold
 * through the wildcard. Never the student, whatever their role says — they
 * are the one side of a 1:1 that is not the team.
 *
 * Who may BE added is exactly who may be on a call when it is booked
 * (resolveCohosts: a role holding calls.invite; the host and the student
 * dropped), held to MAX_CALL_COHOSTS on the call's TOTAL (cohostsToAdd).
 * Anyone already on the call is skipped, so a stale picker, or two people
 * adding the same mentor at once, adds nobody twice and fails nobody. An
 * empty `added` means everyone asked for was already there, which is not an
 * error: Join call still goes straight to the room.
 *
 * Only while the call can still happen (canAddCallCohosts): before it,
 * including an invite the student has yet to answer, and while it is live.
 *
 * And the student is always told who is coming, whoever added them — an admin
 * adding themselves included. In a programme of minors the student must know
 * who will be in the room before they find them there. The people added hear
 * it too (all but whoever added them, who knows), and so does the rest of the
 * staff side, which would otherwise meet a new face in the room.
 *
 * An ActionResult for the reason createInvite gives: every refusal here is a
 * sentence the card shows.
 */
export async function addCallCohosts(
  inviteId: string,
  cohostIds: string[],
): Promise<ActionResult<{ added: string[] }>> {
  return runAction({ name: "addCallCohosts" }, () =>
    addCallCohostsNow(inviteId, cohostIds),
  );
}

async function addCallCohostsNow(
  inviteId: string,
  cohostIds: string[],
): Promise<{ added: string[] }> {
  const actor = await requireActor();
  const admin = createAdminClient();

  if (typeof inviteId !== "string" || !inviteId) {
    throw new Error("That call no longer exists.");
  }
  const { data: invite, error: readError } = await admin
    .from("call_invites")
    .select("id, host_id, invitee_id, status, topic, starts_at, duration_minutes")
    .eq("id", inviteId)
    .maybeSingle();
  // A malformed id (22P02) is "no such call", as it is to the room. Any other
  // failure is not — telling someone a call is gone because of a database
  // blip would send them off to look for it.
  if (readError && readError.code !== "22P02") {
    console.error("[calls] add-people read failed", readError.message);
    throw new Error("Couldn't load that call. Try again in a moment.");
  }
  if (!invite) throw new Error("That call no longer exists.");
  const row = invite as any;

  // Throws on a failed co-host read rather than answering "nobody" — which
  // would refuse a co-host here, and let the cap be counted from zero.
  const parties = await partiesOf(admin, row);
  const onStaff = isStaffOnCall(parties, actor.userId);
  const joiningAny =
    actor.userId !== parties.inviteeId && can(actor.caps, "calls.join_any");
  if (!onStaff && !joiningAny) {
    throw new Error("You're not on this call, so you can't add anyone to it.");
  }

  const timing = timingOf(row);
  if (!canAddCallCohosts(timing)) {
    throw new Error(whyNobodyCanBeAdded(callPhase(timing)));
  }

  const plan = cohostsToAdd(Array.isArray(cohostIds) ? cohostIds : [], parties);
  if (plan.ids.length === 0) return { added: [] };
  if (!plan.fits) {
    throw new Error(
      plan.room === 0
        ? `That's a lot of people for a 1:1. This call already has ${MAX_CALL_COHOSTS} from the team besides its host, which is as many as one can take.`
        : `That's a lot of people for a 1:1. This call has room for ${plan.room} more from the team.`,
    );
  }

  // Role check (and, on a database without 0092, the sentence saying so)
  // before anything is written — only for the people new to the call.
  const cohosts = await resolveCohosts(admin, plan.ids, parties, "existing");
  const added = await addCohostRows(admin, row.id, cohosts);
  // Someone else added them in the moment between our read and our write.
  if (added.length === 0) return { added: [] };

  await logAudit({
    action: "call_invite.cohosts_added",
    targetType: "call_invite",
    targetId: row.id,
    payload: {
      cohost_ids: added.map((c) => c.id),
      // Someone who was not on the call put people on it. That is the
      // override this permission exists for, and exactly what an audit of a
      // programme of minors has to be able to find.
      ...(onStaff ? {} : { via: "calls.join_any" }),
    },
  });

  const joining = joinNames(added.map((c) => c.name));
  const topic = (row.topic as string | null) || null;

  // The student first, and on its own, needing nothing the staff bells below
  // have to look up: of everything said here, this is the one that must
  // arrive. (notify never throws.) "call_invited" because it is the same news
  // as the invite — who this call is with — and classed important by default.
  await notify({
    userId: parties.inviteeId,
    type: "call_invited",
    title: `${joining} will also join your 1:1`,
    body: topic || "Open your 1:1 calls to see everyone who'll be there.",
    link: "/dashboard/calls",
  });

  // Best-effort, like every notification in this file: the people are on the
  // call either way, and every calls page shows who.
  try {
    const staffBefore = callStaffIds(parties).filter((id) => id !== actor.userId);
    const [{ data: named }, roles] = await Promise.all([
      admin
        .from("profiles")
        .select("id, full_name")
        .in("id", [actor.userId, parties.hostId, parties.inviteeId]),
      rolesOf(admin, staffBefore),
    ]);
    const nameOf = new Map(
      ((named ?? []) as any[]).map((r) => [r.id as string, r.full_name as string | null]),
    );
    const hostName = nameOf.get(parties.hostId) || "A member of the team";
    const studentName = nameOf.get(parties.inviteeId) || "a student";

    // Everyone already on the staff side, each linked to their own calls
    // page, as for every other staff bell.
    const links = await Promise.all(
      staffBefore.map((userId) => staffCallsHref(roles.get(userId))),
    );
    await notifyMany(
      staffBefore.map((userId, i) => ({
        userId,
        type: "call_invited",
        title: `${joining} will also join your 1:1 with ${studentName}`,
        body: topic,
        link: links[i],
      })),
    );

    await notifyCohostsAdded(
      added.filter((c) => c.id !== actor.userId),
      {
        hostName,
        studentName,
        topic,
        // "Ana added you to Ben's 1:1 with Sam" when it wasn't the host.
        addedByName:
          actor.userId === parties.hostId
            ? null
            : nameOf.get(actor.userId) || "Someone on the team",
      },
    );
  } catch (err) {
    console.error("[calls] add-people notify failed", err);
  }

  revalidateAll();
  return { added: added.map((c) => c.id) };
}

/** Why nobody can be added to a call in this phase, in the card's words. */
function whyNobodyCanBeAdded(phase: CallPhase): string {
  // An if-chain, not a switch — see callPhase for what the minifier did to one.
  if (phase === "cancelled") {
    return "That call was cancelled, so nobody can be added to it.";
  }
  if (phase === "declined") {
    return "The student declined that call, so nobody can be added to it.";
  }
  if (phase === "expired") {
    return "That invite's time passed without an answer, so nobody can be added to it.";
  }
  return "That call is already over, so nobody can be added to it.";
}

/**
 * Accept or decline. Invitee only — co-hosts are staff, and never answer for
 * the student.
 *
 * Split from the staff's cancel path on purpose. RLS lets everyone on the
 * call update the row — it can't express "this party may only touch this
 * column" — so the narrower rule lives here, and the two callers can't be
 * confused for each other.
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
    // Everyone on the staff side hears the answer, not just whoever sent the
    // invite: a co-host is planning around this call too.
    const staffIds = [
      (invite as any).host_id as string,
      ...(await readCohostIds(admin, id)),
    ];
    const [{ data: me }, roles] = await Promise.all([
      admin.from("profiles").select("full_name").eq("id", actor.userId).maybeSingle(),
      rolesOf(admin, staffIds),
    ]);
    // Each one's OWN calls page, not the student view — the same place the
    // room's Back link sends them (staffCallsHref / hostCallsHref).
    const links = await Promise.all(
      staffIds.map((userId) => staffCallsHref(roles.get(userId))),
    );
    await notifyMany(
      staffIds.map((userId, i) => ({
        userId,
        type: "call_response",
        title: `${(me as any)?.full_name || "A student"} ${response} your 1:1`,
        body: (invite as any).topic || null,
        link: links[i],
      })),
    );
  } catch (err) {
    console.error("[calls] response notify failed", err);
  }

  revalidateAll();
}

/**
 * Cancel. Anyone on the staff side — the host or a co-host (migration 0092) —
 * or a superAdmin. Never the student: they decline instead.
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

  const parties = await partiesOf(admin, invite);
  if (!isStaffOnCall(parties, actor.userId) && !actor.caps.superAdmin) {
    throw new Error("Forbidden");
  }

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
      // The student, and everyone else on the staff side who was planning to
      // be there — each linked to their own calls list. Not whoever pressed
      // Cancel; they know.
      const staff = callStaffIds(parties).filter((userId) => userId !== actor.userId);
      const [roles, { data: named }] = await Promise.all([
        rolesOf(admin, staff),
        admin
          .from("profiles")
          .select("id, full_name")
          .in("id", [actor.userId, parties.inviteeId]),
      ]);
      const links = await Promise.all(
        staff.map((userId) => staffCallsHref(roles.get(userId))),
      );
      // The staff bell names the student and who cancelled, as every other
      // staff-facing call bell names the student: someone with a dozen calls
      // can't tell which one "A 1:1 call was cancelled" meant, and the topic
      // that would have said so is optional. The student's own stays as it
      // was — they have one call with this team, and know who it was with.
      const nameOf = new Map(
        ((named ?? []) as any[]).map((r) => [r.id as string, r.full_name as string | null]),
      );
      const staffTitle = `${nameOf.get(actor.userId) || "Someone on the team"} cancelled the 1:1 with ${
        nameOf.get(parties.inviteeId) || "a student"
      }`;
      await notifyMany([
        ...(parties.inviteeId !== actor.userId
          ? [
              {
                userId: parties.inviteeId,
                type: "call_cancelled",
                title: "A 1:1 call was cancelled",
                body: (invite as any).topic || null,
                link: "/dashboard/calls",
              },
            ]
          : []),
        ...staff.map((userId, i) => ({
          userId,
          type: "call_cancelled",
          title: staffTitle,
          body: (invite as any).topic || null,
          link: links[i],
        })),
      ]);
    } catch (err) {
      console.error("[calls] cancel notify failed", err);
    }
  }

  revalidateAll();
}

/**
 * End a call, for everyone on it. Anyone on the call — the student, the host
 * or a co-host — through the live room's End call button (broadcast-room's
 * `finishCall`).
 *
 * Marks the call `completed` only once its scheduled start has come
 * (canMarkCallCompleted): two people who joined early and left again have not
 * had their call, and completing it would lock them out of the room at the
 * proper time. Before the start this is a no-op that says so, and the button
 * simply takes them back to their calls.
 *
 * Idempotent: ending a call that is already completed — someone else got
 * there first — succeeds quietly.
 *
 * Deliberately revalidates NOTHING, unlike every other action in this file.
 * Next re-renders the CURRENT route whenever an action revalidates any path at
 * all, and the current route here is the room itself — /dashboard/calls/<id>/
 * live, which renders a static "This call has ended" for a completed call.
 * The recorder has only CAPTURED its final part when End call is pressed;
 * the upload is still running. Revalidating swapped the room for that static
 * page mid-upload: the room unmounted, taking with it the "keep this tab
 * open" note, the unload prompt and the navigation back to the calls list,
 * and a host who then closed the tab lost the end of the conversation without
 * a word.
 *
 * Nothing needs the revalidation. Every calls list (and the interview card)
 * is a dynamic, per-user render and the client router cache is off for dynamic
 * pages (staleTimes.dynamic = 0), so the room's push back to the list — and
 * the other person's next visit — renders fresh anyway. The other person's
 * room learns of the End from its status poll or heartbeat, not from a render.
 * Whoever is recording finishes uploading after the row is completed: a
 * take's parts need only its own lease (/api/recordings), not an open call.
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
  if (!(await onCall(admin, row, actor.userId))) throw new Error("Forbidden");
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
  }
  return { completed };
}

/**
 * Is this call over? Polled by everyone in the room.
 *
 * batch0 Live has no server in the media path, so when one person presses End
 * call everyone else's browser sees only a peer that went away — which is
 * also what a dropped connection looks like. This is how the room tells the
 * two apart: the row says completed (or cancelled), or the window has closed,
 * and the room closes itself — flushing the recording on the way out —
 * instead of sitting on "reconnecting" for half an hour.
 *
 * Null for anyone who is not on the call, the same non-answer the join gate
 * gives, so it can't be used to learn which calls exist. A failed co-host read
 * THROWS instead (readCohostIds), because the room reads null as "over" and
 * would close a co-host's call on a database blip; the poll shrugs off a
 * throw and asks again.
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
  if (!(await onCall(admin, row, actor.userId))) return null;
  return { over: isPastPhase(callPhase(timingOf(row))) };
}
