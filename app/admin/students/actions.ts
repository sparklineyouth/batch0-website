"use server";
import { revalidatePath } from "next/cache";
import { assertPermission } from "@/lib/server-guards";
import { changeRoles } from "@/lib/role-change-server";
import type { ActionResult } from "@/lib/action-result";
import type { Role } from "@/lib/types";

/**
 * Roles are rows in `public.app_roles` since migration 0048, so "is this a
 * valid role" is a lookup rather than a hard-coded list — that's what lets a
 * custom role like `intern` be assigned here the moment it's created.
 *
 * Note what this action does NOT require: an application, an acceptance, a
 * cohort, or a payment. Somebody signs up, an admin picks their role, done.
 *
 * Who may change whose role is decided in one place for this, the bulk change
 * and the email form at /admin/roles (lib/role-change.ts): nobody re-roles
 * themselves, nobody hands out or takes away access they don't hold, and
 * somebody always keeps full access. The permission guard still throws (a
 * caller without people.roles gets a 500, which scripts/e2e-roles.mts relies
 * on); the refusals an admin has to act on come back as results, because a
 * thrown message is replaced with a generic one in production builds
 * (lib/action-result.ts).
 */
export async function changeUserRole(userId: string, role: Role): Promise<ActionResult> {
  const actor = await assertPermission("people.roles");
  const res = await changeRoles({ actor, userIds: [userId], role });
  if (res.error !== null) return { ok: false, error: res.error };
  const refused = res.skipped[0] ?? res.failed[0];
  if (refused) return { ok: false, error: refused.reason };

  revalidatePath("/admin/students");
  revalidatePath(`/admin/students/${userId}`);
  revalidatePath("/admin/roles");
  return { ok: true };
}

/**
 * Set-based counterpart of changeUserRole, through the same rule: one read,
 * one update per current role (usually one), one audit insert for the whole
 * batch, however many users are picked. A destination the actor can't hand
 * out fails the whole batch (`error`); the actor's own account, anyone whose
 * role holds more than the actor's, and anyone already in the role are
 * skipped and counted as such.
 */
export async function bulkChangeUserRole(input: {
  userIds: string[];
  role: Role;
}): Promise<{ succeeded: number; failed: number; skipped: number; error?: string }> {
  const actor = await assertPermission("people.roles");
  if (input.userIds.length === 0) {
    return { succeeded: 0, failed: 0, skipped: 0 };
  }
  if (input.userIds.length > 200) {
    return { succeeded: 0, failed: 0, skipped: 0, error: "Cap bulk role changes at 200 users per run." };
  }

  const res = await changeRoles({ actor, userIds: input.userIds, role: input.role });
  if (res.error !== null) {
    return { succeeded: 0, failed: 0, skipped: 0, error: res.error };
  }

  for (const c of res.changed) revalidatePath(`/admin/students/${c.id}`);
  revalidatePath("/admin/students");
  revalidatePath("/admin/roles");
  return {
    succeeded: res.changed.length,
    failed: res.failed.length,
    skipped: res.skipped.length,
  };
}
