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
