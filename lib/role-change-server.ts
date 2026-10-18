import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllRoles } from "@/lib/roles";
import { logAuditMany } from "@/lib/audit";
import { getUser } from "@/lib/auth";
import type { Capabilities } from "@/lib/permissions";
import {
  LAST_FULL_ADMIN,
  isFullAccessRole,
  isLastFullAdminError,
  planRoleChange,
} from "@/lib/role-change";

/**
 * The one writer of `profiles.role` for people changes: the email form, the
 * picker and the bulk change all come through here (lib/role-change.ts has
 * the rule and why). The caller has already asserted people.roles.
 *
 * Fails closed: if the targets' current roles can't be read, nothing is
 * written, because rule 3 (you can't change someone who holds admin powers
 * you don't) is decided on exactly that read.
 *
 * The write is a compare-and-set on the role that was read
 * (`where id in (...) and role = <what we saw>`), grouped by that role. A
 * target whose role changed in between — promoted to admin by someone else a
 * second ago, say — matches nothing and is reported as failed, rather than
 * being overwritten by a decision made about their old role. The database's
 * keep_a_full_admin trigger (0103) refuses a write that would leave nobody
 * with full access, including two admins demoting each other at once.
 */

export type RoleChangeOutcome =
  | { error: string }
  | {
      error: null;
      changed: { id: string; from: string; email: string | null }[];
      skipped: { id: string; reason: string }[];
      failed: { id: string; reason: string }[];
    };

export async function changeRoles(input: {
  actor: { userId: string; caps: Capabilities };
  userIds: readonly string[];
  role: string;
  /** Recorded on the audit rows, e.g. "roles_page". */
  via?: string;
}): Promise<RoleChangeOutcome> {
  const { actor, role } = input;
  const ids = Array.from(new Set(input.userIds));
  const roles = await getAllRoles();
  const admin = createAdminClient();

  const { data: rows, error: readErr } = await admin
    .from("profiles")
    .select("id, role, email")
    .in("id", ids);
  if (readErr) {
    return { error: `Couldn't read their current roles, so nothing was changed: ${readErr.message}` };
  }
  const byId = new Map(
    ((rows ?? []) as { id: string; role: string; email: string | null }[]).map((r) => [r.id, r]),
  );
  const missing = ids.filter((id) => !byId.has(id));
  const targets = ids.filter((id) => byId.has(id)).map((id) => ({ id, role: byId.get(id)!.role }));

  // Who holds full access now, read only when a full admin might lose it.
  const next = roles.find((r) => r.slug === role);
  const fullRoles = roles.filter(isFullAccessRole).map((r) => r.slug);
  const touchesFullAdmin =
    !isFullAccessRole(next) && targets.some((t) => fullRoles.includes(t.role));
  let fullAdminIds: string[] | null = null;
  if (touchesFullAdmin) {
    const { data: admins, error: adminsErr } = await admin
      .from("profiles")
      .select("id")
      .in("role", fullRoles);
    if (adminsErr) {
      return { error: `Couldn't check who else has full access, so nothing was changed: ${adminsErr.message}` };
    }
    fullAdminIds = ((admins ?? []) as { id: string }[]).map((a) => a.id);
  }

  const plan = planRoleChange({ actor, roles, targets, nextRole: role, fullAdminIds });
  if (plan.error) return { error: plan.error };

  const skipped = [
    ...plan.skipped,
    ...missing.map((id) => ({ id, reason: "That account no longer exists." })),
  ];
  const changed: { id: string; from: string; email: string | null }[] = [];
  const failed: { id: string; reason: string }[] = [];

  const groups = new Map<string, string[]>();
  for (const t of plan.change) groups.set(t.role, [...(groups.get(t.role) ?? []), t.id]);
  for (const [from, groupIds] of groups) {
    const { data: updated, error } = await admin
      .from("profiles")
      .update({ role })
      .in("id", groupIds)
      .eq("role", from)
      .select("id");
    if (error) {
      const reason = isLastFullAdminError(error.message) ? LAST_FULL_ADMIN : error.message;
      for (const id of groupIds) failed.push({ id, reason });
      continue;
    }
    const done = new Set(((updated ?? []) as { id: string }[]).map((u) => u.id));
    for (const id of groupIds) {
      if (done.has(id)) changed.push({ id, from, email: byId.get(id)?.email ?? null });
      else failed.push({ id, reason: "Their role changed while you were editing. Refresh and try again." });
    }
  }

  // The guard's actor carries no email; the request's user does (cached, so
  // free), and the audit pages show who acted by it.
  const user = changed.length > 0 ? await getUser() : null;
  await logAuditMany(
    { userId: actor.userId, email: user?.id === actor.userId ? (user.email ?? null) : null },
    changed.map((c) => ({
      action: "user.role_changed",
      targetType: "profile",
      targetId: c.id,
      payload: {
        from: c.from,
        to: role,
        email: c.email,
        ...(input.via ? { via: input.via } : {}),
      },
    })),
  );

  return { error: null, changed, skipped, failed };
}
