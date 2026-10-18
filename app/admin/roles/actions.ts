"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { getRole, type AppRole } from "@/lib/roles";
import { changeRoles, decideRoleChange } from "@/lib/role-change-server";
import { roleSaveRefusal } from "@/lib/role-impact";
import {
  ROLE_SLUG_PATTERN,
  ROLE_COLOR_KEYS,
  WILDCARD,
  covers,
  missingPermissions,
  isKnownPermission,
  isReservedSlug,
  isSystemRole,
  isValidRoleHome,
  slugifyRole,
} from "@/lib/permissions";
import { isRefusal, refuse, runAction, type ActionResult } from "@/lib/action-result";

export type RoleInput = {
  slug: string;
  label: string;
  description: string;
  permissions: string[];
  homePath: string;
  color: string;
};

const MAX_ROLES = 40;

/**
 * Validate and normalise the permission list.
 *
 * Two rules matter here:
 *  - unknown keys are dropped, so a stale form post can't write a permission
 *    string nothing in the app will ever check (it would look granted but do
 *    nothing, which is worse than being rejected);
 *  - the '*' wildcard is never accepted from a form. Full power is reserved
 *    for the built-in `admin` role, otherwise "create a role" quietly becomes
 *    "create an admin" and privilege escalation is one checkbox away.
 */
function cleanPermissions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const key = raw.trim();
    if (key === WILDCARD) continue;
    if (!isKnownPermission(key)) continue;
    seen.add(key);
  }
  return Array.from(seen).sort();
}

/**
 * You cannot hand out a permission you don't hold yourself.
 *
 * Without this, `roles.manage` alone would be enough to mint a role with
 * `settings.manage`, assign it to yourself, and walk up to full control. Full
 * admins hold the wildcard so this never constrains them.
 *
 * Only *added* permissions are checked. A role that already carries something
 * the editor lacks isn't an escalation — refusing the save would just make
 * that role unrenamable by anyone but a full admin — and removing one is a
 * de-escalation, which is always allowed.
 */
async function assertCanGrant(permissions: string[], existing: string[] = []) {
  const actor = await assertPermission("roles.manage");
  if (actor.caps.superAdmin) return actor;
  const added = permissions.filter((p) => !existing.includes(p));
  const missing = missingPermissions(actor.caps, added);
  if (missing.length > 0) {
    refuse(`You can't grant a permission you don't hold yourself: ${missing.join(", ")}.`);
  }
  return actor;
}

/**
 * The form's own rules. The permission-list part (none ticked, a
 * PERMISSION_NEEDS pair split, removing roles.manage from the role you hold)
 * is roleSaveRefusal in lib/role-impact.ts, which the editor also runs as
 * boxes are ticked, so it says the same thing before Save that this says
 * after. Every rule here is a refusal (lib/action-result.ts), not logged.
 */
function validate(
  input: RoleInput,
  permissions: string[],
  existing?: { role: AppRole; actorRole: string },
) {
  const label = input.label.trim();
  if (label.length < 2) refuse("Give the role a name.");
  if (label.length > 40) refuse("Keep the role name under 40 characters.");

  if (!isValidRoleHome(input.homePath)) {
    refuse("Pick a valid landing page for this role.");
  }
  if (!ROLE_COLOR_KEYS.includes(input.color as any)) {
    refuse("Pick a valid colour.");
  }
  const refusal = roleSaveRefusal({
    permissions,
    existing: existing?.role ?? null,
    actorRole: existing?.actorRole ?? null,
  });
  if (refusal) refuse(refusal);
  return { label, description: input.description.trim().slice(0, 400) };
}

/** Log a failure; a refusal is the action answering, so it isn't logged. */
function logFailure(name: string, err: unknown) {
  if (!isRefusal(err)) console.error(`[action:${name}]`, err);
}

export async function createRole(input: RoleInput): Promise<ActionResult<{ slug: string }>> {
  try {
    const permissions = cleanPermissions(input.permissions);
    await assertCanGrant(permissions);
    const { label, description } = validate(input, permissions);

    const slug = slugifyRole(input.slug || input.label);
    if (!ROLE_SLUG_PATTERN.test(slug)) {
      refuse(
        "The slug must start with a letter and use only lowercase letters, numbers, and hyphens.",
      );
    }
    if (isReservedSlug(slug)) {
      refuse(`"${slug}" is reserved. Pick a different name.`);
    }

    const admin = createAdminClient();
    const { count } = await admin
      .from("app_roles")
      .select("slug", { count: "exact", head: true });
    if ((count ?? 0) >= MAX_ROLES) {
      refuse(`You already have ${MAX_ROLES} roles. Delete one first.`);
    }

    const { error } = await admin.from("app_roles").insert({
      slug,
      label,
      description: description || null,
      permissions,
      home_path: input.homePath,
      color: input.color,
      is_system: false,
      rank: 100,
    });
    if (error) {
      if (error.code === "23505") {
        refuse(`A role with the slug "${slug}" already exists.`);
      }
      throw new Error(error.message);
    }

    await logAudit({
      action: "role.created",
      targetType: "app_role",
      targetId: slug,
      payload: { label, permissions, home_path: input.homePath },
    });

    revalidatePath("/admin/roles");
    revalidatePath("/admin/students");
    return { ok: true, data: { slug } };
  } catch (err: any) {
    logFailure("createRole", err);
    return { ok: false, error: err?.message ?? "Could not create the role." };
  }
}

export async function updateRole(input: RoleInput): Promise<ActionResult> {
  try {
    const permissions = cleanPermissions(input.permissions);
    const existing = await getRole(input.slug);
    if (!existing) refuse("That role no longer exists.");

    // Checked before the grant rules so the message is the useful one. The
    // built-in admin role keeps the wildcard: saving this form against it
    // would strip '*' down to the ticked boxes and lock every admin out of
    // their own site — including whoever pressed the button. The detail page
    // renders an explanation instead of the form, so reaching here means a
    // hand-made request.
    if (existing.permissions.includes(WILDCARD)) {
      refuse(`"${existing.label}" has full access by definition and can't be narrowed here.`);
    }

    const actor = await assertCanGrant(permissions, existing.permissions);
    // Includes "you can't remove roles.manage from the role you hold", which
    // would otherwise lock everyone out of this page.
    const { label, description } = validate(input, permissions, {
      role: existing,
      actorRole: actor.role,
    });

    const admin = createAdminClient();
    const { error } = await admin
      .from("app_roles")
      .update({
        label,
        description: description || null,
        permissions,
        home_path: input.homePath,
        color: input.color,
      })
      .eq("slug", input.slug);
    if (error) throw new Error(error.message);

    const added = permissions.filter((p) => !existing.permissions.includes(p));
    const removed = existing.permissions.filter((p) => !permissions.includes(p));

    await logAudit({
      action: "role.updated",
      targetType: "app_role",
      targetId: input.slug,
      payload: { label, added, removed, home_path: input.homePath },
    });

    revalidatePath("/admin/roles");
    revalidatePath(`/admin/roles/${input.slug}`);
    revalidatePath("/admin/students");
    revalidatePath("/admin", "layout");
    return { ok: true };
  } catch (err: any) {
    logFailure("updateRole", err);
    return { ok: false, error: err?.message ?? "Could not save the role." };
  }
}

/**
 * Delete a custom role, moving everyone who holds it to `reassignTo` first —
 * `profiles.role` is a foreign key, so the move isn't optional.
 */
export async function deleteRole(
  slug: string,
  reassignTo: string,
): Promise<ActionResult<{ moved: number }>> {
  try {
    const actor = await assertPermission("roles.manage");
    if (isSystemRole(slug)) {
      refuse("Built-in roles can't be deleted.");
    }
    if (slug === reassignTo) {
      refuse("Pick a different role to move people to.");
    }
    if (actor.role === slug) {
      refuse("You can't delete the role you're currently holding.");
    }

    const target = await getRole(reassignTo);
    if (!target) refuse("Pick a role to move people to.");
    // Deleting a role must not be a backdoor to handing out access the
    // deleter doesn't have.
    if (!covers(actor.caps, target.permissions)) {
      refuse(`You can't move people into "${target.label}" — it holds permissions you don't have.`);
    }

    // Move first, then delete — the FK would reject the delete otherwise.
    // Not a transaction: if the delete below fails, people have already been
    // reassigned and the role lingers with zero members. That's recoverable
    // by retrying, and it fails in the safe direction (nobody is left holding
    // a role that no longer exists).
    const admin = createAdminClient();
    const { data: moved, error: moveErr } = await admin
      .from("profiles")
      .update({ role: reassignTo })
      .eq("role", slug)
      .select("id");
    if (moveErr) throw new Error(moveErr.message);

    const { error } = await admin.from("app_roles").delete().eq("slug", slug);
    if (error) throw new Error(error.message);

    await logAudit({
      action: "role.deleted",
      targetType: "app_role",
      targetId: slug,
      payload: { reassigned_to: reassignTo, moved: moved?.length ?? 0 },
    });

    revalidatePath("/admin/roles");
    revalidatePath("/admin/students");
    return { ok: true, data: { moved: moved?.length ?? 0 } };
  } catch (err: any) {
    logFailure("deleteRole", err);
    return { ok: false, error: err?.message ?? "Could not delete the role." };
  }
}

/**
 * The account an email belongs to, for the email form and its preview.
 * Refuses with the form's own words when there is none.
 */
async function accountByEmail(email: string) {
  const clean = email.trim().toLowerCase();
  if (!clean || !clean.includes("@")) refuse("Enter a valid email.");

  const admin = createAdminClient();
  const { data: profile, error: findErr } = await admin
    .from("profiles")
    .select("id, email, full_name, role")
    .ilike("email", clean)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);
  if (!profile) {
    refuse(`No account for ${clean}. Ask them to sign up first, then assign the role.`);
  }
  return {
    clean,
    profile: profile as { id: string; email: string; full_name: string | null; role: string },
  };
}

/**
 * Give an existing account a role, by email.
 *
 * This is the "you don't apply for a role, you're given one" path: the person
 * signs up like anyone else, and an admin hands them the role afterwards. No
 * application, no cohort, no payment involved.
 *
 * The change itself goes through the same rule as the People pages
 * (lib/role-change.ts). This form used to exempt full admins from "you can't
 * change your own role", which let a sole admin demote themselves and leave
 * the site with nobody holding full access.
 */
export async function grantRoleByEmail(
  email: string,
  slug: string,
): Promise<ActionResult<{ name: string; email: string }>> {
  try {
    const actor = await assertPermission("people.roles");

    const role = await getRole(slug);
    if (!role) refuse("That role doesn't exist.");
    // Same escalation rule as role editing: you can't hand out more than you
    // hold. Checked again by changeRoles; here so the message comes before
    // the email lookup, as it always has.
    if (!covers(actor.caps, role.permissions)) {
      refuse(`You can't assign "${role.label}" — it holds permissions you don't have.`);
    }

    const { clean, profile } = await accountByEmail(email);
    if (profile.role === slug) {
      refuse(`${clean} already holds the ${role.label} role.`);
    }

    const res = await changeRoles({
      actor,
      userIds: [profile.id],
      role: slug,
      via: "roles_page",
    });
    // The destination was checked above, so an error here is a failed read.
    if (res.error !== null) throw new Error(res.error);
    // A skip is the guard saying no (your own role, someone holding admin
    // powers you don't); a failure is a write that didn't land, and is logged.
    if (res.skipped[0]) refuse(res.skipped[0].reason);
    if (res.failed[0]) throw new Error(res.failed[0].reason);

    revalidatePath("/admin/roles");
    revalidatePath("/admin/students");
    return {
      ok: true,
      data: { name: profile.full_name || profile.email, email: profile.email },
    };
  } catch (err: any) {
    logFailure("grantRoleByEmail", err);
    return { ok: false, error: err?.message ?? "Could not assign the role." };
  }
}

/**
 * Who an email belongs to, the role they hold now, and whether assigning
 * `slug` would be refused, and why: the email form's preview, shown before
 * Assign is pressed. Reads only. The refusal is changeRoles' own decision on
 * the same reads (decideRoleChange), so the preview and the write agree;
 * what the person would gain or lose is worked out in the form from the
 * role definitions (lib/role-impact.ts).
 *
 * Gated like the write, on people.roles. It says nothing grantRoleByEmail's
 * own answers don't: that account's name and role ("already holds…").
 */
export async function previewRoleGrant(
  email: string,
  slug: string,
): Promise<
  ActionResult<{ name: string; email: string; role: string; refusal: string | null }>
> {
  return runAction({ name: "previewRoleGrant" }, async () => {
    const actor = await assertPermission("people.roles");
    const role = await getRole(slug);
    if (!role) refuse("That role doesn't exist.");
    const { clean, profile } = await accountByEmail(email);
    const name = profile.full_name || profile.email;
    let refusal: string | null = null;
    if (!covers(actor.caps, role.permissions)) {
      refusal = `You can't assign "${role.label}" — it holds permissions you don't have.`;
    } else if (profile.role === slug) {
      refusal = `${clean} already holds the ${role.label} role.`;
    } else {
      const decided = await decideRoleChange({ actor, userIds: [profile.id], role: slug });
      if (decided.error !== null) throw new Error(decided.error);
      refusal = decided.plan.skipped[0]?.reason ?? null;
    }
    return { name, email: profile.email, role: profile.role, refusal };
  });
}
