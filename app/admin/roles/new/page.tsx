import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { ALL_PERMISSIONS } from "@/lib/permissions";
import { RoleForm } from "../role-form";

export const metadata = { title: "New role · Admin" };

export default async function NewRolePage() {
  const { caps } = await requirePermission("roles.manage");
  // Full admins can grant anything; everyone else only what they already hold.
  const grantable = caps.superAdmin
    ? null
    : ALL_PERMISSIONS.filter((p) => caps.permissions.includes(p));

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/admin/roles"
        className="text-xs text-ink-faint hover:text-ink"
      >
        ← Roles
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        New role
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-faint">
        Name it, then tick what it can reach. You can change any of this later —
        people holding the role pick up the change on their next page load.
      </p>

      <div className="mt-8">
        <RoleForm
          mode="create"
          grantable={grantable}
          initial={{
            slug: "",
            label: "",
            description: "",
            permissions: [],
            homePath: "/admin",
            color: "sky",
          }}
        />
      </div>
    </div>
  );
}
