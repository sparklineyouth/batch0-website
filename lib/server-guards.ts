import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { capabilitiesForRole } from "@/lib/roles";
import {
  can,
  canAccessAdmin,
  type Capabilities,
  type Permission,
} from "@/lib/permissions";
import type { Role } from "@/lib/types";

/**
 * Server-action / route-handler guards. These throw `Error` so server
 * actions can let the error bubble up to the client transition.
 *
 * `assertPermission("area.verb")` is the one to reach for: it names the
 * capability the action needs, which is the same string an admin ticks for a
 * role at /admin/roles. The older role-shaped guards below are kept for the
 * handful of places where the check really is "is this person an admin" or
 * "is this person mentor-or-above".
 *
 * A page-level guard is not enough on its own — server actions are their own
 * entry point and are callable by anyone who can guess the action id, so
 * every mutation re-checks here.
 */

/**
 * The actor for a MUTATION, verified against the auth server.
 *
 * Deliberately `supabase.auth.getUser()` and not the shared, request-cached
 * getUser() from lib/auth.ts. That one now verifies the JWT locally
 * (getClaims) to keep reads fast, which is the right trade for "which page may
 * you see" — but it means a token stays good until its `exp`, up to an hour
 * after the account behind it is gone.
 *
 * This module guards writes, including `admin.auth.admin.deleteUser()` in
 * app/admin/students/[id]/actions.ts. If "delete this account" left the
 * deleted principal able to invoke server actions for another hour, that is
 * not a performance trade, it is a broken security control. getUser() asks
 * GoTrue whether the user still exists, so revocation is immediate here.
 *
 * The cost is one network round trip per mutation, which is noise next to the
 * write itself. Still request-cached, so an action passing through several
 * guards plus logAudit pays it once and they all agree on the actor.
 */
const getActor = cache(async function getActor(): Promise<{
  userId: string;
  role: Role;
  caps: Capabilities;
}> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profile?.role as Role) ?? "student";
  return { userId: user.id, role, caps: await capabilitiesForRole(role) };
});

/** The signed-in user's capabilities. Throws when signed out. */
export async function requireActor(): Promise<{
  userId: string;
  role: Role;
  caps: Capabilities;
}> {
  return getActor();
}

/**
 * The main write guard. Throws "Forbidden" unless the actor's role carries
 * `permission` (or the '*' wildcard).
 */
export async function assertPermission(permission: Permission): Promise<{
  userId: string;
  role: Role;
  caps: Capabilities;
}> {
  const actor = await getActor();
  if (!can(actor.caps, permission)) throw new Error("Forbidden");
  return actor;
}

/** Throws unless the actor holds every one of `permissions`. */
export async function assertAllPermissions(
  permissions: readonly Permission[],
): Promise<{ userId: string; role: Role; caps: Capabilities }> {
  const actor = await getActor();
  for (const p of permissions) {
    if (!can(actor.caps, p)) throw new Error("Forbidden");
  }
  return actor;
}

/** Throws unless the actor belongs in the admin area at all. */
export async function assertAdminArea(): Promise<{
  userId: string;
  role: Role;
  caps: Capabilities;
}> {
  const actor = await getActor();
  if (!canAccessAdmin(actor.caps)) throw new Error("Forbidden");
  return actor;
}

/**
 * Full-power admin — the '*' wildcard, not merely admin-area access. Reserve
 * for operations with no narrower permission; prefer `assertPermission`.
 */
export async function assertAdmin(): Promise<{ userId: string }> {
  const actor = await getActor();
  if (!actor.caps.superAdmin) throw new Error("Forbidden");
  return { userId: actor.userId };
}

/** Mentor-or-above: write access to program content and student feedback. */
export async function assertStaff(): Promise<{
  userId: string;
  role: Role;
}> {
  const actor = await getActor();
  if (!can(actor.caps, "mentor.panel")) throw new Error("Forbidden");
  return { userId: actor.userId, role: actor.role };
}

export async function assertSelf(): Promise<{ userId: string }> {
  // Same reasoning as getActor(): this authorises writes, so it verifies
  // against the auth server rather than trusting a locally-valid JWT.
  const { userId } = await getActor();
  return { userId };
}
