"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAllPermissions, assertPermission } from "@/lib/server-guards";
import { runAction, type ActionResult } from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { easternDate } from "@/lib/assignments";
import { isUuid } from "@/lib/support-access";
import {
  FOLLOWUP_COLUMNS,
  FOLLOWUP_READ_PERMISSION,
  FOLLOWUP_WRITE_PERMISSION,
  canWriteFollowUps,
  isOneOpenConflict,
  parseClosingNote,
  parseFollowUpInput,
  type FollowUpView,
} from "@/lib/student-followups";
import {
  getFollowUpThread,
  listFollowUpOwners,
  type FollowUpOwner,
} from "@/lib/student-followups-server";

/**
 * The follow-up drawer on /admin/progress (migration 0107).
 *
 * Reading needs people.view, the page's own key; starting, changing and
 * closing one needs people.manage as well. Every write is service-role with
 * the check here, because the table has no client policies at all.
 *
 * None of these send anything. Not to the student, and not to someone made
 * the owner — they see it on the page and in their Overview's attention
 * list when it comes due. A follow-up is a note between staff.
 */

const NOT_READY = "Follow-ups aren't set up yet (migration 0107).";
const CHANGED =
  "Someone else changed or closed this follow-up just now. Close the drawer and open it again to see the latest.";

const WRITE_KEYS = [FOLLOWUP_READ_PERMISSION, FOLLOWUP_WRITE_PERMISSION] as const;

function dbError(error: unknown, fallback: string): Error {
  return new Error(isMissingSchemaError(error) ? NOT_READY : fallback);
}

function revalidate() {
  revalidatePath("/admin/progress");
  revalidatePath("/admin");
}

export type FollowUpDrawerData = {
  ready: boolean;
  student: { id: string; name: string };
  active: FollowUpView | null;
  history: FollowUpView[];
  /** Empty for a read-only viewer: they never see the form. */
  owners: FollowUpOwner[];
  canEdit: boolean;
  viewerId: string;
  /** New York date, so the date picker and the server agree on "today". */
  today: string;
};

export async function loadFollowUp(studentId: string): Promise<ActionResult<FollowUpDrawerData>> {
  return runAction({ name: "loadFollowUp" }, async () => {
    const actor = await assertPermission(FOLLOWUP_READ_PERMISSION);
    if (!isUuid(studentId)) throw new Error("Student not found.");
    const admin = createAdminClient();
    const canEdit = canWriteFollowUps(actor.caps);
    const [{ data: profile }, thread, owners] = await Promise.all([
      admin.from("profiles").select("id, full_name, email").eq("id", studentId).maybeSingle(),
      getFollowUpThread(studentId),
      canEdit ? listFollowUpOwners() : Promise.resolve([] as FollowUpOwner[]),
    ]);
    if (!profile) throw new Error("Student not found.");
    return {
      ready: thread.ready,
      student: { id: profile.id, name: profile.full_name?.trim() || profile.email || "Student" },
      active: thread.active,
      history: thread.history,
      owners,
      canEdit,
      viewerId: actor.userId,
      today: easternDate(new Date()),
    };
  });
}

/**
 * Start a follow-up (no `followUpId`) or change the open one. A change names
 * the version it was made against (`expectedUpdatedAt`): if someone else
 * saved or closed it in between, nothing is written and the drawer says so,
 * rather than one person's owner or date quietly replacing the other's.
 */
export async function saveFollowUp(input: {
  studentId: string;
  followUpId: string | null;
  expectedUpdatedAt: string | null;
  ownerId: string;
  nextCheckOn: string;
  note: string;
}): Promise<ActionResult<{ id: string }>> {
  return runAction({ name: "saveFollowUp" }, async () => {
    const actor = await assertAllPermissions(WRITE_KEYS);
    if (!isUuid(input.studentId)) throw new Error("Student not found.");
    const today = easternDate(new Date());
    const parsed = parseFollowUpInput(input, today);
    if (!parsed.ok) throw new Error(parsed.error);
    const { ownerId, nextCheckOn, note } = parsed.value;

    const admin = createAdminClient();
    const [{ data: student }, owners] = await Promise.all([
      admin.from("profiles").select("id").eq("id", input.studentId).maybeSingle(),
      listFollowUpOwners(),
    ]);
    if (!student) throw new Error("Student not found.");
    // The owner must be someone who can update and close it.
    if (!owners.some((o) => o.id === ownerId)) throw new Error("That person can't own follow-ups.");

    let id: string;
    if (!input.followUpId) {
      const { data, error } = await admin
        .from("student_followups")
        .insert({
          student_id: input.studentId,
          owner_id: ownerId,
          next_check_on: nextCheckOn,
          note,
          created_by: actor.userId,
          updated_by: actor.userId,
        })
        .select("id")
        .single();
      if (error && isOneOpenConflict(error)) {
        // Someone got there first. Say who, so nobody starts chasing twice.
        const { data: open } = await admin
          .from("student_followups")
          .select("owner_id")
          .eq("student_id", input.studentId)
          .eq("status", "open")
          .maybeSingle();
        const ownerName = open?.owner_id ? owners.find((o) => o.id === open.owner_id)?.name : null;
        throw new Error(
          `${ownerName ?? "Someone on the team"} already has an open follow-up for this student. Close the drawer and open it again to see it.`,
        );
      }
      if (error || !data) throw dbError(error, "Couldn't start the follow-up.");
      id = data.id;
    } else {
      if (!isUuid(input.followUpId) || !input.expectedUpdatedAt) throw new Error(CHANGED);
      const { data, error } = await admin
        .from("student_followups")
        .update({ owner_id: ownerId, next_check_on: nextCheckOn, note, updated_by: actor.userId })
        .eq("id", input.followUpId)
        .eq("student_id", input.studentId)
        .eq("status", "open")
        .eq("updated_at", input.expectedUpdatedAt)
        .select("id");
      if (error) throw dbError(error, "Couldn't save the follow-up.");
      if (!data || data.length === 0) throw new Error(CHANGED);
      id = data[0].id;
    }

    // The note stays out of the audit log: who did what, not what they wrote.
    await logAudit({
      action: input.followUpId ? "student.followup_updated" : "student.followup_started",
      targetType: "profile",
      targetId: input.studentId,
      payload: { followup_id: id, owner_id: ownerId, next_check_on: nextCheckOn },
    });
    revalidate();
    return { id };
  });
}

/** Close the open follow-up, with an optional line on how it ended. */
export async function closeFollowUp(input: {
  followUpId: string;
  expectedUpdatedAt: string;
  closingNote?: string | null;
}): Promise<ActionResult> {
  return runAction({ name: "closeFollowUp" }, async () => {
    const actor = await assertAllPermissions(WRITE_KEYS);
    if (!isUuid(input.followUpId) || !input.expectedUpdatedAt) throw new Error(CHANGED);
    const closing = parseClosingNote(input.closingNote);
    if (!closing.ok) throw new Error(closing.error);
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("student_followups")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        closed_by: actor.userId,
        updated_by: actor.userId,
        closing_note: closing.value,
      })
      .eq("id", input.followUpId)
      .eq("status", "open")
      .eq("updated_at", input.expectedUpdatedAt)
      .select(FOLLOWUP_COLUMNS);
    if (error) throw dbError(error, "Couldn't close the follow-up.");
    const row = (data ?? [])[0] as { student_id: string } | undefined;
    if (!row) throw new Error(CHANGED);
    await logAudit({
      action: "student.followup_closed",
      targetType: "profile",
      targetId: row.student_id,
      payload: { followup_id: input.followUpId },
    });
    revalidate();
  });
}
