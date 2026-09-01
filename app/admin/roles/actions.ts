"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { syncMemberRoles } from "@/lib/discord";
import { getRole } from "@/lib/roles";
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
import type { ActionResult } from "@/lib/action-result";

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
    throw new Error(
      `You can't grant a permission you don't hold yourself: ${missing.join(", ")}.`,
    );
  }
  return actor;
}

function validate(input: RoleInput, permissions: string[]) {
  const label = input.label.trim();
  if (label.length < 2) throw new Error("Give the role a name.");
  if (label.length > 40) throw new Error("Keep the role name under 40 characters.");

  if (!isValidRoleHome(input.homePath)) {
    throw new Error("Pick a valid landing page for this role.");
  }
  if (!ROLE_COLOR_KEYS.includes(input.color as any)) {
    throw new Error("Pick a valid colour.");
  }
  if (permissions.length === 0) {
    throw new Error(
      "A role with no permissions can't reach anything. Tick at least one.",
    );
  }
  return { label, description: input.description.trim().slice(0, 400) };
}

export async function createRole(input: RoleInput): Promise<ActionResult<{ slug: string }>> {
  try {
    const permissions = cleanPermissions(input.permissions);
    await assertCanGrant(permissions);
    const { label, description } = validate(input, permissions);

    const slug = slugifyRole(input.slug || input.label);
    if (!ROLE_SLUG_PATTERN.test(slug)) {
      throw new Error(
        "The slug must start with a letter and use only lowercase letters, numbers, and hyphens.",
      );
    }
    if (isReservedSlug(slug)) {
      throw new Error(`"${slug}" is reserved. Pick a different name.`);
    }

    const admin = createAdminClient();
    const { count } = await admin
      .from("app_roles")
      .select("slug", { count: "exact", head: true });
    if ((count ?? 0) >= MAX_ROLES) {
      throw new Error(`You already have ${MAX_ROLES} roles. Delete one first.`);
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
        throw new Error(`A role with the slug "${slug}" already exists.`);
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
    console.error("[action:createRole]", err);
    return { ok: false, error: err?.message ?? "Could not create the role." };
  }
}

export async function updateRole(input: RoleInput): Promise<ActionResult> {
  try {
    const permissions = cleanPermissions(input.permissions);
    const existing = await getRole(input.slug);
    if (!existing) throw new Error("That role no longer exists.");

    // Checked before the grant rules so the message is the useful one. The
    // built-in admin role keeps the wildcard: saving this form against it
    // would strip '*' down to the ticked boxes and lock every admin out of
    // their own site — including whoever pressed the button. The detail page
    // renders an explanation instead of the form, so reaching here means a
    // hand-made request.
    if (existing.permissions.includes(WILDCARD)) {
      throw new Error(
        `"${existing.label}" has full access by definition and can't be narrowed here.`,
      );
    }

    const actor = await assertCanGrant(permissions, existing.permissions);
    const { label, description } = validate(input, permissions);

    // A role that can manage roles can otherwise quietly remove that ability
    // from the role it's standing on and lock everyone out of this page.
    if (
      existing.permissions.includes("roles.manage") &&
      !permissions.includes("roles.manage") &&
      actor.role === existing.slug
    ) {
      throw new Error(
        "That would remove your own ability to manage roles. Ask a full admin to do it.",
      );
    }

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
    console.error("[action:updateRole]", err);
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
      throw new Error("Built-in roles can't be deleted.");
    }
    if (slug === reassignTo) {
      throw new Error("Pick a different role to move people to.");
    }
    if (actor.role === slug) {
      throw new Error("You can't delete the role you're currently holding.");
    }

    const target = await getRole(reassignTo);
    if (!target) throw new Error("Pick a role to move people to.");
    // Deleting a role must not be a backdoor to handing out access the
    // deleter doesn't have.
    if (!covers(actor.caps, target.permissions)) {
      throw new Error(
        `You can't move people into "${target.label}" — it holds permissions you don't have.`,
      );
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
    console.error("[action:deleteRole]", err);
    return { ok: false, error: err?.message ?? "Could not delete the role." };
  }
}

/**
 * Give an existing account a role, by email.
 *
 * This is the "you don't apply for a role, you're given one" path: the person
 * signs up like anyone else, and an admin hands them the role afterwards. No
 * application, no cohort, no payment involved.
 */
export async function grantRoleByEmail(
  email: string,
  slug: string,
): Promise<ActionResult<{ name: string; email: string }>> {
  try {
    const actor = await assertPermission("people.roles");

    const role = await getRole(slug);
    if (!role) throw new Error("That role doesn't exist.");
    // Same escalation rule as role editing: you can't hand out more than you
    // hold. Blocks `people.roles` alone from being a route to full admin.
    if (!covers(actor.caps, role.permissions)) {
      throw new Error(
        `You can't assign "${role.label}" — it holds permissions you don't have.`,
      );
    }

    const clean = email.trim().toLowerCase();
    if (!clean || !clean.includes("@")) throw new Error("Enter a valid email.");

    const admin = createAdminClient();
    const { data: profile, error: findErr } = await admin
      .from("profiles")
      .select("id, email, full_name, role")
      .ilike("email", clean)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (!profile) {
      throw new Error(
        `No account for ${clean}. Ask them to sign up first, then assign the role.`,
      );
    }
    if (profile.role === slug) {
      throw new Error(`${clean} already holds the ${role.label} role.`);
    }
    if (profile.id === actor.userId && !actor.caps.superAdmin) {
      throw new Error("You can't change your own role.");
    }

    const { error } = await admin
      .from("profiles")
      .update({ role: slug })
      .eq("id", profile.id);
    if (error) throw new Error(error.message);

    await logAudit({
      action: "user.role_changed",
      targetType: "profile",
      targetId: profile.id,
      payload: { from: profile.role, to: slug, email: profile.email, via: "roles_page" },
    });

    // Best-effort Discord sync — custom roles have no Discord role mapped, in
    // which case syncMemberRoles just strips the managed ones.
    try {
      const { data: link } = await admin
        .from("profiles")
        .select("discord_user_id")
        .eq("id", profile.id)
        .maybeSingle();
      if ((link as any)?.discord_user_id) {
        await syncMemberRoles((link as any).discord_user_id, slug).catch(() => {});
      }
    } catch {
      // discord_user_id column absent (pre-0008) — ignore.
    }

    revalidatePath("/admin/roles");
    revalidatePath("/admin/students");
    return {
      ok: true,
      data: { name: profile.full_name || profile.email, email: profile.email },
    };
  } catch (err: any) {
    console.error("[action:grantRoleByEmail]", err);
    return { ok: false, error: err?.message ?? "Could not assign the role." };
  }
}
