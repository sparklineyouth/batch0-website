import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth";
import { getAllRoles, getRole, getRoleMemberCounts } from "@/lib/roles";
import {
  ADMIN_ROUTE_PERMISSIONS,
  ALL_PERMISSIONS,
  PERMISSION_BY_KEY,
  canAccessAdmin,
  capabilitiesFrom,
  covers,
  isSystemRole,
  roleColorClasses,
} from "@/lib/permissions";
import { RoleForm } from "../role-form";
import { DeleteRole } from "./delete-role";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}) {
  const role = await getRole(params.slug);
  return { title: `${role?.label ?? "Role"} · Admin` };
}

export default async function RoleDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  const { caps } = await requirePermission("roles.manage");
  const [role, roles, counts] = await Promise.all([
    getRole(params.slug),
    getAllRoles(),
    getRoleMemberCounts(),
  ]);
  if (!role) notFound();

  const roleCaps = capabilitiesFrom(role.slug, role.permissions);
  const members = counts[role.slug] ?? 0;

  // A sample of who holds it — enough to recognise the role in the wild
  // without turning this into a second People page.
  const admin = createAdminClient();
  const { data: holders } = await admin
    .from("profiles")
    .select("id, email, full_name")
    .eq("role", role.slug)
    .order("created_at", { ascending: false })
    .limit(8);

  const grantable = caps.superAdmin
    ? null
    : ALL_PERMISSIONS.filter((p) => caps.permissions.includes(p));

  // Where this role can navigate, derived from the same table the guard uses.
  const reachable = ADMIN_ROUTE_PERMISSIONS.filter(([, perm]) =>
    roleCaps.superAdmin ? true : role.permissions.includes(perm),
  ).map(([prefix]) => prefix);

  const deleteTargets = roles
    .filter((r) => r.slug !== role.slug)
    .filter((r) => covers(caps, r.permissions))
    .map((r) => ({ slug: r.slug, label: r.label }));

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/roles" className="text-xs text-ink-faint hover:text-ink">
        ← Roles
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          {role.label}
        </h1>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${roleColorClasses(
            role.color,
          )}`}
        >
          {role.slug}
        </span>
        {role.is_system && (
          <span className="rounded-full border border-line px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider text-ink-faint">
            built-in
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-faint">
        {members} {members === 1 ? "person holds" : "people hold"} this role ·{" "}
        {canAccessAdmin(roleCaps)
          ? "can open the admin area"
          : "no admin access"}
      </p>

      {roleCaps.superAdmin ? (
        <Card className="mt-8">
          <h2 className="font-display text-lg font-semibold tracking-tight text-ink">
            Full access
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {role.label} holds the wildcard grant: every permission that exists
            today and every one added later. It can&apos;t be narrowed here —
            doing so would lock every admin, including you, out of the site. To
            give someone less, make a new role and assign it to them.
          </p>
          <Link
            href="/admin/roles/new"
            className="mt-3 inline-block text-sm text-phosphor-ink hover:underline"
          >
            Create a narrower role →
          </Link>
        </Card>
      ) : (
        <div className="mt-8">
          <RoleForm
            mode="edit"
            grantable={grantable}
            initial={{
              slug: role.slug,
              label: role.label,
              description: role.description ?? "",
              permissions: role.permissions,
              homePath: role.home_path,
              color: role.color,
            }}
          />
        </div>
      )}

      {reachable.length > 0 && (
        <Card className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
            Pages this role can open
          </h2>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {reachable.map((href) => (
              <code
                key={href}
                className="rounded border border-line bg-paper px-2 py-0.5 font-mono text-[11px] text-ink-soft"
              >
                {href}
              </code>
            ))}
          </div>
          {!roleCaps.superAdmin && role.permissions.length > 0 && (
            <>
              <h3 className="mt-5 text-sm font-semibold uppercase tracking-wider text-ink-soft">
                Granted permissions
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-ink-soft">
                {role.permissions.map((p) => (
                  <li key={p}>
                    <span className="font-mono text-xs text-ink-faint">{p}</span>
                    {PERMISSION_BY_KEY.get(p) && (
                      <span> — {PERMISSION_BY_KEY.get(p)!.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}

      {(holders?.length ?? 0) > 0 && (
        <Card className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
            Who holds it
          </h2>
          <ul className="mt-3 divide-y divide-line">
            {holders!.map((h) => (
              <li key={h.id} className="py-2">
                <Link
                  href={`/admin/students/${h.id}`}
                  className="text-sm text-ink hover:text-phosphor-ink"
                >
                  {h.full_name || h.email}
                </Link>
                {h.full_name && (
                  <span className="ml-2 text-xs text-ink-faint">{h.email}</span>
                )}
              </li>
            ))}
          </ul>
          {members > (holders?.length ?? 0) && (
            <Link
              href={`/admin/students?role=${role.slug}`}
              className="mt-3 inline-block text-sm text-phosphor-ink hover:underline"
            >
              See all {members} →
            </Link>
          )}
        </Card>
      )}

      {!isSystemRole(role.slug) && (
        <Card className="mt-6 border-red-500/30">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
            Danger zone
          </h2>
          <div className="mt-3">
            <DeleteRole
              slug={role.slug}
              label={role.label}
              members={members}
              targets={deleteTargets}
            />
          </div>
        </Card>
      )}
    </div>
  );
}
