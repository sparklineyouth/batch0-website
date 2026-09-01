"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit, logAuditMany } from "@/lib/audit";
import { syncMemberRoles } from "@/lib/discord";
import { getRole } from "@/lib/roles";
import { covers } from "@/lib/permissions";
import type { Role } from "@/lib/types";

/**
 * Roles are rows in `public.app_roles` since migration 0048, so "is this a
 * valid role" is a lookup rather than a hard-coded list — that's what lets a
 * custom role like `intern` be assigned here the moment it's created.
 *
 * Note what this action does NOT require: an application, an acceptance, a
 * cohort, or a payment. Somebody signs up, an admin picks their role, done.
 */
async function guardRoleChange(role: Role) {
  const actor = await assertPermission("people.roles");
  const target = await getRole(role);
  if (!target) throw new Error(`"${role}" isn't a role.`);
  // You can't hand out access you don't hold yourself — the same rule the
  // roles page enforces. Full admins hold the wildcard and skip it.
  if (!covers(actor.caps, target.permissions)) {
    throw new Error(
      `You can't assign "${target.label}" — it holds permissions you don't have.`,
    );
  }
  return actor;
}

export async function changeUserRole(userId: string, role: Role) {
  const actor = await guardRoleChange(role);
  const actorId = actor.userId;
  // Nobody re-roles themselves. Previously this only blocked an admin
  // downgrading their own admin bit; now that any role can carry
  // `people.roles`, self-service in either direction is a way to escape the
  // "can't grant what you don't hold" rule above.
  if (userId === actorId && role !== actor.role) {
    throw new Error("You can't change your own role. Ask another admin.");
  }
  const admin = createAdminClient();
  // Read the core columns first — those are guaranteed to exist.
  const { data: prev } = await admin
    .from("profiles")
    .select("role, email")
    .eq("id", userId)
    .single();
  const { error } = await admin
    .from("profiles")
    .update({ role })
    .eq("id", userId);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "user.role_changed",
    targetType: "profile",
    targetId: userId,
    payload: { from: prev?.role ?? null, to: role, email: prev?.email },
  });

  // Best-effort Discord sync. discord_user_id is added by migration 0008 —
  // tolerate the column being absent so admin role changes still succeed.
  // Custom roles have no Discord role mapped; syncMemberRoles then just
  // strips the managed ones, which is the correct outcome.
  try {
    const { data: link, error: linkErr } = await admin
      .from("profiles")
      .select("discord_user_id")
      .eq("id", userId)
      .maybeSingle();
    if (!linkErr && (link as any)?.discord_user_id) {
      await syncMemberRoles((link as any).discord_user_id, role).catch(
        () => {},
      );
    }
  } catch {
    // ignore — column doesn't exist
  }
  revalidatePath("/admin/students");
  revalidatePath(`/admin/students/${userId}`);
  revalidatePath("/admin/roles");
}

/**
 * Set-based counterpart of changeUserRole: one read, one update, one audit
 * insert for the whole batch, however many users are picked. The per-user
 * loop it replaces issued ~6 round trips per user and timed out near the
 * 200-user cap. Guard semantics are identical to the single-user path: an
 * invalid role or a role the actor can't cover fails the whole batch, while
 * the actor's own id is skipped (nobody re-roles themselves) and reported
 * as such.
 */
export async function bulkChangeUserRole(input: {
  userIds: string[];
  role: Role;
}): Promise<{ succeeded: number; failed: number; skipped: number }> {
  const actor = await guardRoleChange(input.role);
  const actorId = actor.userId;
  if (input.userIds.length === 0) {
    return { succeeded: 0, failed: 0, skipped: 0 };
  }
  if (input.userIds.length > 200) {
    throw new Error("Cap bulk role changes at 200 users per run.");
  }

  const targetIds = input.userIds.filter((id) => id !== actorId);
  const skipped = input.userIds.length - targetIds.length;
  if (targetIds.length === 0) {
    revalidatePath("/admin/students");
    return { succeeded: 0, failed: 0, skipped };
  }

  const admin = createAdminClient();

  // One read for the whole batch, feeding both the audit trail (previous
  // role) and the Discord sync. discord_user_id is added by migration 0008 —
  // retry without it so a missing column can't fail role changes, the same
  // tolerance changeUserRole keeps. A failed read is otherwise non-fatal:
  // the update below still runs and the audit records `from: null`, exactly
  // as the per-user path behaved when its prev-role select came back empty.
  const withDiscord = await admin
    .from("profiles")
    .select("id, role, email, discord_user_id")
    .in("id", targetIds);
  const { data: targets } = withDiscord.error
    ? await admin.from("profiles").select("id, role, email").in("id", targetIds)
    : withDiscord;
  const prevById = new Map<
    string,
    { role: Role | null; email: string | null; discord_user_id?: string | null }
  >(((targets ?? []) as any[]).map((t) => [t.id as string, t]));

  // One write for the whole batch. An id with no profiles row matches
  // nothing and still counts as succeeded — the same outcome as the
  // per-user path, where a zero-row update isn't an error.
  const { error } = await admin
    .from("profiles")
    .update({ role: input.role })
    .in("id", targetIds);
  if (error) {
    revalidatePath("/admin/students");
    return { succeeded: 0, failed: targetIds.length, skipped };
  }

  await logAuditMany(
    actor,
    targetIds.map((id) => ({
      action: "user.role_changed",
      targetType: "profile",
      targetId: id,
      payload: {
        from: prevById.get(id)?.role ?? null,
        to: input.role,
        email: prevById.get(id)?.email,
      },
    })),
  );

  // Best-effort Discord sync, same contract as the single-user path: a
  // failed sync never fails or undoes the role change. Bounded concurrency
  // so 200 linked accounts don't hit Discord's API all at once.
  const linked = targetIds
    .map((id) => prevById.get(id)?.discord_user_id)
    .filter((d): d is string => Boolean(d));
  const SYNC_CHUNK = 5;
  for (let i = 0; i < linked.length; i += SYNC_CHUNK) {
    await Promise.allSettled(
      linked
        .slice(i, i + SYNC_CHUNK)
        .map((discordId) => syncMemberRoles(discordId, input.role)),
    );
  }

  for (const id of targetIds) revalidatePath(`/admin/students/${id}`);
  revalidatePath("/admin/students");
  revalidatePath("/admin/roles");
  return { succeeded: targetIds.length, failed: 0, skipped };
}
