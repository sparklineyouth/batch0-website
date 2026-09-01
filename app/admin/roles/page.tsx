import Link from "next/link";
import { Card } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { getAllRoles, getRoleMemberCounts, rolesTableReady } from "@/lib/roles";
import {
  ALL_PERMISSIONS,
  can,
  canAccessAdmin,
  capabilitiesFrom,
  covers,
  roleColorClasses,
} from "@/lib/permissions";
import { GrantRoleForm } from "./grant-form";
import { ArrowRight, Plus, Users } from "lucide-react";

export const metadata = { title: "Roles & permissions · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminRolesPage() {
  const { caps } = await requirePermission("roles.manage");
  const [roles, counts, ready] = await Promise.all([
    getAllRoles(),
    getRoleMemberCounts(),
    rolesTableReady(),
  ]);

  const canAssign = can(caps, "people.roles");
  // You can only hand out what you hold — mirrors the check in actions.ts.
  const assignable = roles.filter((r) => covers(caps, r.permissions));

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Roles &amp; permissions
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-faint">
            A role is a named set of permissions. Everyone with an account holds
            exactly one. Change what a role can do and every person holding it
            changes with it — no deploy, no re-signup.
          </p>
        </div>
        <ButtonLink href="/admin/roles/new">
          <Plus className="h-4 w-4 shrink-0" />
          New role
        </ButtonLink>
      </div>

      {!ready && (
        <Card className="mt-6 border-amber-500/40">
          <h2 className="text-sm font-semibold text-ink">
            Database migration not applied yet
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            The roles below are the built-in defaults compiled into the app, not
            editable rows. Run{" "}
            <code className="font-mono text-xs">
              supabase/migrations/0048_custom_roles.sql
            </code>{" "}
            in the Supabase SQL editor, then reload this page.
          </p>
        </Card>
      )}

      <div className="mt-6 space-y-3">
        {roles.map((role) => {
          const roleCaps = capabilitiesFrom(role.slug, role.permissions);
          const members = counts[role.slug] ?? 0;
          const permCount = roleCaps.superAdmin
            ? ALL_PERMISSIONS.length
            : role.permissions.length;
          return (
            <Link
              key={role.slug}
              href={`/admin/roles/${role.slug}`}
              className="press group block rounded-xl border border-line bg-wash px-5 py-4 hover:border-ink/30"
            >
              <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${roleColorClasses(
                        role.color,
                      )}`}
                    >
                      {role.label}
                    </span>
                    {role.is_system && (
                      <span className="rounded-full border border-line px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider text-ink-faint">
                        built-in
                      </span>
                    )}
                    {roleCaps.superAdmin && (
                      <span className="rounded-full border border-phosphor/40 px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider text-phosphor-ink">
                        full access
                      </span>
                    )}
                  </div>
                  {role.description && (
                    <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
                      {role.description}
                    </p>
                  )}
                  <p className="mt-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                    {permCount} permission{permCount === 1 ? "" : "s"} ·{" "}
                    {canAccessAdmin(roleCaps) ? "admin area" : "no admin area"} ·
                    lands on {role.home_path}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center gap-1.5 text-sm tabular-nums text-ink-soft">
                    <Users className="h-3.5 w-3.5 text-ink-faint" />
                    {members}
                  </span>
                  <ArrowRight className="h-4 w-4 text-ink-faint group-hover:text-ink" />
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {canAssign && assignable.length > 0 && (
        <Card className="mt-8">
          <h2 className="font-display text-lg font-semibold tracking-tight text-ink">
            Give someone a role
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            Roles aren&apos;t applied for. The person signs up at{" "}
            <code className="font-mono text-xs">/signup</code> like anyone else,
            then you assign their role here — no application, cohort, or payment
            in the way.
          </p>
          <GrantRoleForm
            roles={assignable.map((r) => ({ slug: r.slug, label: r.label }))}
          />
        </Card>
      )}
    </div>
  );
}
