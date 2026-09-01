import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  capabilitiesFrom,
  isSystemRole,
  resolveHome,
  type Capabilities,
} from "@/lib/permissions";

/**
 * Server-side reads of `public.app_roles` (migration 0048).
 *
 * Service-role only — never import this from a client component or from
 * middleware (which is Edge and has its own inline lookup). Pure logic lives
 * in lib/permissions.ts; this file is only the data access around it.
 */

export type AppRole = {
  slug: string;
  label: string;
  description: string | null;
  permissions: string[];
  home_path: string;
  color: string;
  is_system: boolean;
  rank: number;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  "slug, label, description, permissions, home_path, color, is_system, rank, created_at, updated_at";

/**
 * What the four system roles are, expressed without the database.
 *
 * Used only when `app_roles` can't be read — the table is missing because
 * migration 0048 hasn't been applied yet, or the DB is briefly unreachable.
 * Values mirror the seed in that migration, so an un-migrated deploy behaves
 * exactly as it did before this feature existed rather than locking every
 * admin out of their own site.
 */
const FALLBACK_ROLES: AppRole[] = [
  {
    slug: "student",
    label: "Student",
    description: null,
    permissions: ["student.dashboard"],
    home_path: "/dashboard",
    color: "slate",
    is_system: true,
    rank: 10,
    created_at: "",
    updated_at: "",
  },
  {
    slug: "admin",
    label: "Admin",
    description: null,
    permissions: ["*"],
    home_path: "/admin",
    color: "phosphor",
    is_system: true,
    rank: 20,
    created_at: "",
    updated_at: "",
  },
  {
    slug: "mentor",
    label: "Mentor",
    description: null,
    permissions: ["mentor.panel"],
    home_path: "/mentor",
    color: "emerald",
    is_system: true,
    rank: 30,
    created_at: "",
    updated_at: "",
  },
  {
    slug: "investor",
    label: "Investor",
    description: null,
    permissions: ["investor.panel"],
    home_path: "/investor",
    color: "purple",
    is_system: true,
    rank: 40,
    created_at: "",
    updated_at: "",
  },
];

let warnedMissingTable = false;

/**
 * Every role, cheapest-privilege first. Request-cached: a single page render
 * hits this from the layout, the sidebar, and the page body.
 */
export const getAllRoles = cache(async function getAllRoles(): Promise<
  AppRole[]
> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("app_roles")
    .select(COLUMNS)
    .order("rank", { ascending: true })
    .order("label", { ascending: true });

  if (error || !data) {
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      console.error(
        "[roles] could not read app_roles — falling back to the built-in roles. " +
          "Has supabase/migrations/0048_custom_roles.sql been applied?",
        error?.message,
      );
    }
    return FALLBACK_ROLES;
  }
  return data.map(normalizeRole);
});

function normalizeRole(row: any): AppRole {
  return {
    slug: row.slug,
    label: row.label ?? row.slug,
    description: row.description ?? null,
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    home_path: row.home_path ?? "/dashboard",
    color: row.color ?? "slate",
    is_system: !!row.is_system,
    rank: typeof row.rank === "number" ? row.rank : 100,
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? "",
  };
}

export async function getRole(slug: string): Promise<AppRole | null> {
  const roles = await getAllRoles();
  return roles.find((r) => r.slug === slug) ?? null;
}

/**
 * Capabilities for a role slug. An unknown slug resolves to no permissions
 * rather than throwing — a profile pointing at a deleted role should lose
 * access, not 500 the request.
 */
export async function capabilitiesForRole(
  slug: string | null | undefined,
): Promise<Capabilities> {
  if (!slug) return capabilitiesFrom("student", []);
  const role = await getRole(slug);
  return capabilitiesFrom(slug, role?.permissions ?? []);
}

/** Where a member of this role should land. */
export async function homeForRole(slug: string | null | undefined): Promise<string> {
  const role = slug ? await getRole(slug) : null;
  const caps = capabilitiesFrom(slug ?? "student", role?.permissions ?? []);
  return resolveHome(caps, role?.home_path ?? null);
}

/**
 * How many people hold each role, keyed by slug. Head-only count queries,
 * one per role in parallel — the roles list is request-cached (getAllRoles),
 * no profile rows cross the wire, and the numbers stay exact however large
 * the directory grows.
 */
export async function getRoleMemberCounts(): Promise<Record<string, number>> {
  const roles = await getAllRoles();
  const admin = createAdminClient();
  const entries = await Promise.all(
    roles.map(async ({ slug }) => {
      const { count, error } = await admin
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", slug);
      return [slug, error ? 0 : (count ?? 0)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * True once `app_roles` is actually queryable. The roles admin uses this to
 * explain itself instead of silently rendering the fallback list as if those
 * were editable rows.
 */
export async function rolesTableReady(): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin.from("app_roles").select("slug").limit(1);
  return !error;
}

export { isSystemRole };
