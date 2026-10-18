/**
 * Who may change whose role: the one rule behind every path that writes
 * `profiles.role` — the email form at /admin/roles, the picker on a person's
 * row and profile, and the bulk change on /admin/students. Pure, so the
 * pages can show the same answer the server enforces, and `node --test`
 * runs it as-is.
 *
 * The three paths used to carry three slightly different copies, and two
 * holes followed:
 *   - the email form exempted full admins from "you can't change your own
 *     role", so a sole admin could demote themselves and leave nobody with
 *     full access;
 *   - the picker and the bulk change checked that the actor could hand out
 *     the DESTINATION role, but not that they held what the target already
 *     had, so a delegated role manager (people.roles alone) could turn a full
 *     admin into a student.
 *
 * The rule now, for an actor holding people.roles:
 *   1. nobody changes their own role, full admins included;
 *   2. you can't assign a role that holds anything you don't (the long-standing
 *      escalation rule);
 *   3. you can't change someone whose CURRENT role holds admin powers you
 *      don't — so only a full admin changes a full admin, and a delegate
 *      can't strip someone of, say, payments.manage they don't hold;
 *   4. the change can't leave nobody with full access.
 * The database enforces 4 on its own (0103's keep_a_full_admin trigger, which
 * also serialises concurrent demotions); 1–3 need to know who is acting, which
 * only the app does.
 *
 * Rule 3 compares admin powers only, not the participant and panel keys
 * (student.dashboard, mentor.panel, investor.panel, calls.invite,
 * calls.join_any). Every new account is a Student, the Student role holds
 * student.dashboard, and staff roles normally don't (its description says to
 * grant it only to roles that take part in the programme). Comparing every
 * key locked a delegated role manager out of every Student row, which is the
 * change that role exists to make. Taking a panel key away is a de-escalation,
 * and handing one out is still rule 2's business.
 */
import { ADMIN_AREA_PERMISSIONS, WILDCARD, covers, type Capabilities } from "./permissions.ts";

export type RoleDef = {
  slug: string;
  label: string;
  permissions: readonly string[];
};

export type RoleChangeActor = { userId: string; caps: Capabilities };

export type RoleChangeTarget = { id: string; role: string };

export const SELF_ROLE_CHANGE = "You can't change your own role. Ask another admin.";
export const LAST_FULL_ADMIN =
  "batch0 needs at least one full admin, and this would leave none. Make someone else a full admin first.";

/** True when the role is a full-access one (holds the '*' wildcard). */
export function isFullAccessRole(role: Pick<RoleDef, "permissions"> | null | undefined): boolean {
  return !!role && role.permissions.includes(WILDCARD);
}

const ADMIN_POWERS: ReadonlySet<string> = new Set<string>([WILDCARD, ...ADMIN_AREA_PERMISSIONS]);

/**
 * The part of a role rule 3 compares: the wildcard and the admin-area keys.
 * Panel keys and strings the catalog no longer knows (a stale row) grant no
 * admin power, so they don't make someone untouchable.
 */
export function adminPowersOf(permissions: readonly string[]): string[] {
  return permissions.filter((p) => ADMIN_POWERS.has(p));
}

/**
 * Why `actor` can't move `target` off their current role at all, whatever the
 * destination — or null when they can. The People pages use this to decide
 * whether a row gets a picker or a plain badge.
 */
export function roleChangeLock(
  actor: RoleChangeActor,
  target: RoleChangeTarget,
  roles: readonly RoleDef[],
): string | null {
  if (target.id === actor.userId) return SELF_ROLE_CHANGE;
  // A profile pointing at a role that no longer exists holds nothing.
  const current = roles.find((r) => r.slug === target.role);
  if (current && !covers(actor.caps, adminPowersOf(current.permissions))) {
    return isFullAccessRole(current)
      ? "Only a full admin can change a full admin's role."
      : `You can't change the role of someone who is "${current.label}": it holds admin permissions you don't have.`;
  }
  return null;
}

/** Why `actor` can't hand out `slug` to anyone — or null when they can. */
export function roleAssignRefusal(
  actor: RoleChangeActor,
  slug: string,
  roles: readonly RoleDef[],
): string | null {
  const next = roles.find((r) => r.slug === slug);
  if (!next) return `"${slug}" isn't a role.`;
  if (!covers(actor.caps, next.permissions)) {
    return `You can't assign "${next.label}" — it holds permissions you don't have.`;
  }
  return null;
}

export type RoleChangePlan = {
  /** Set when nothing in the batch may change (the destination is refused). */
  error: string | null;
  /** Targets to move to the new role. */
  change: RoleChangeTarget[];
  /** Targets left as they are, each with the reason. */
  skipped: { id: string; reason: string }[];
};

/**
 * Decide a role change for a batch of targets (one, for the email form and
 * the picker). `fullAdminIds` is everyone who holds a full-access role now.
 * It's only consulted when a full admin would lose full access, so callers
 * may pass null when no target is a full admin; null with a full-admin
 * target reads as "nobody else has full access", and refuses (fails closed).
 */
export function planRoleChange(input: {
  actor: RoleChangeActor;
  roles: readonly RoleDef[];
  targets: readonly RoleChangeTarget[];
  nextRole: string;
  fullAdminIds: readonly string[] | null;
}): RoleChangePlan {
  const { actor, roles, targets, nextRole } = input;
  const refusal = roleAssignRefusal(actor, nextRole, roles);
  if (refusal) return { error: refusal, change: [], skipped: [] };
  const next = roles.find((r) => r.slug === nextRole)!;
  const label = next.label;

  const change: RoleChangeTarget[] = [];
  const skipped: RoleChangePlan["skipped"] = [];
  for (const t of targets) {
    if (t.role === nextRole) {
      skipped.push({ id: t.id, reason: `They already hold the "${label}" role.` });
      continue;
    }
    const lock = roleChangeLock(actor, t, roles);
    if (lock) {
      skipped.push({ id: t.id, reason: lock });
      continue;
    }
    change.push(t);
  }

  // Rules 1 and 3 already keep the actor (a full admin, if any full admin is
  // being changed) out of the batch, so this only bites when the actor's own
  // standing is stale. Cheap to check, and the trigger would refuse anyway —
  // this just says it before the write.
  if (!isFullAccessRole(next)) {
    const losing = new Set(
      change
        .filter((t) => isFullAccessRole(roles.find((r) => r.slug === t.role)))
        .map((t) => t.id),
    );
    if (losing.size > 0) {
      const remaining = (input.fullAdminIds ?? []).filter((id) => !losing.has(id));
      if (remaining.length === 0) {
        return {
          error: null,
          change: change.filter((t) => !losing.has(t.id)),
          skipped: [
            ...skipped,
            ...[...losing].map((id) => ({ id, reason: LAST_FULL_ADMIN })),
          ],
        };
      }
    }
  }
  return { error: null, change, skipped };
}

/**
 * A write refused by 0103's trigger, recognised from its message so the admin
 * reads the reason rather than a database error.
 */
export function isLastFullAdminError(message: string | null | undefined): boolean {
  return !!message && /at least one full admin/i.test(message);
}
