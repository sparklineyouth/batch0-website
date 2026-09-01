import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth";
import { getAllRoles } from "@/lib/roles";
import { can, covers } from "@/lib/permissions";
import { StudentsBulkList } from "./bulk-list";
import { PeopleSearch } from "./people-search";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Role } from "@/lib/types";

export const metadata = { title: "People · Admin" };
// Without this the router cache can serve a stale RSC payload when an
// admin navigates back to /admin/students after enrolling/disabling
// users — they'd see a partial list until a hard reload refreshed it.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const PAGE_SIZE = 100;

function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? "1");
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

export default async function AdminStudentsPage({
  searchParams,
}: {
  searchParams: { role?: string; page?: string; q?: string };
}) {
  const { caps } = await requirePermission("people.view");
  const admin = createAdminClient();

  // Filter tabs come from the roles table, so a role created at /admin/roles
  // shows up here — with its own tab and count — without a code change.
  // "enrolled" is a synthetic tab (not a role): it filters to people who hold
  // at least one cohort enrollment, cutting across every role.
  const roles = await getAllRoles();
  const filter =
    searchParams.role === "enrolled" ||
    (searchParams.role && roles.some((r) => r.slug === searchParams.role))
      ? searchParams.role!
      : "all";
  const enrolledOnly = filter === "enrolled";
  const page = parsePage(searchParams.page);
  const offset = (page - 1) * PAGE_SIZE;

  // Free-text search over name + email. Sanitized before it reaches the
  // PostgREST `.or()` grammar: commas/parens/asterisks are separators or
  // wildcards there, so strip them to keep the query well-formed and prevent
  // filter injection. Length-capped so a pathological term can't bloat the URL.
  const search = (searchParams.q ?? "").trim().slice(0, 100);
  const term = search.replace(/[,()*%\\]/g, " ").trim();

  // Paged rather than a one-shot fetch: the directory grows without bound and
  // every row used to ride the RSC payload into the client list. count:'exact'
  // drives the pager; role filter and search both stay in SQL.
  // `!inner` turns the enrollment embed into an inner join, so the Enrolled
  // tab returns only profiles that actually hold an enrollment (and its count
  // reflects the same). Every other tab keeps the outer join so people with no
  // enrollment still appear.
  const enrollmentEmbed = enrolledOnly
    ? "enrollments!enrollments_user_id_fkey!inner(cohort_id, cohort:cohorts(name))"
    : "enrollments!enrollments_user_id_fkey(cohort_id, cohort:cohorts(name))";

  let q = admin
    .from("profiles")
    .select(
      `id, email, full_name, role, created_at, applications!applications_user_id_fkey(status), ${enrollmentEmbed}`,
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  // Only actual role slugs filter by role; "all" and "enrolled" do not.
  if (filter !== "all" && !enrolledOnly) q = q.eq("role", filter);
  // Case-insensitive substring match on either column. `*term*` is PostgREST's
  // wildcard form inside `.or()` (the JS `%` form is only for standalone
  // `.ilike`).
  if (term) q = q.or(`full_name.ilike.*${term}*,email.ilike.*${term}*`);

  // Tab counts are head-only count queries — one per role plus the "all"
  // total — so no profile rows are transferred just to be counted, and all
  // of them ride alongside the page query instead of after it.
  const [
    { data: profiles, count: filteredCount },
    { count: allCount },
    { count: enrolledCount },
    roleCounts,
  ] = await Promise.all([
    q,
    admin.from("profiles").select("id", { count: "exact", head: true }),
    // Head count of profiles with at least one enrollment (inner join, no rows
    // transferred) — drives the Enrolled tab's badge.
    admin
      .from("profiles")
      .select("enrollments!enrollments_user_id_fkey!inner(cohort_id)", {
        count: "exact",
        head: true,
      }),
    Promise.all(
      roles.map((r) =>
        admin
          .from("profiles")
          .select("id", { count: "exact", head: true })
          .eq("role", r.slug),
      ),
    ),
  ]);
  const countBySlug = new Map(
    roles.map((r, i) => [r.slug, roleCounts[i].count ?? 0]),
  );
  const roleCount = (slug: string) => countBySlug.get(slug) ?? 0;

  const totalCount = filteredCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  // Role tab links carry no page param, so switching tabs lands on page 1.
  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("role", filter);
    if (search) params.set("q", search);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/admin/students?${qs}` : "/admin/students";
  };

  // Assignable roles are capped by what the viewer holds — the same rule the
  // server action enforces, surfaced early so the picker never offers an
  // option that would be rejected.
  const canChangeRoles = can(caps, "people.roles");
  const roleOptions = roles
    .filter((r) => covers(caps, r.permissions))
    .map((r) => ({ slug: r.slug, label: r.label, color: r.color }));

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">People</h1>
          <p className="mt-1 text-sm text-ink-faint">
            {canChangeRoles ? (
              <>
                Everyone with an account. Change a role inline to grant or
                revoke access — no application needed.{" "}
                <Link
                  href="/admin/roles"
                  className="text-phosphor-ink hover:underline"
                >
                  Manage roles →
                </Link>
              </>
            ) : (
              <>Everyone with an account.</>
            )}
          </p>
        </div>
        <a
          href="/api/admin/export/people"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-wash px-3 py-1.5 text-xs font-medium text-ink hover:border-ink/30 hover:bg-ink/[0.04]"
        >
          Export CSV
        </a>
      </div>

      {/* Search by name or email. Server-side (DB ilike) so it spans the whole
          directory, not just the rows already loaded on this page. */}
      <div className="mt-6">
        <PeopleSearch initialQuery={search} role={filter} />
      </div>

      {/* Role tabs with counts. Each preserves the active search term so
          switching tabs narrows within the current query instead of clearing it. */}
      <div className="mt-4 flex flex-wrap gap-2">
        {[
          { slug: "all", label: "All" },
          { slug: "enrolled", label: "Enrolled" },
          ...roles,
        ].map((f) => {
          const active = filter === f.slug;
          const count =
            f.slug === "all"
              ? allCount ?? 0
              : f.slug === "enrolled"
                ? enrolledCount ?? 0
                : roleCount(f.slug);
          // Hide empty tabs for custom roles so the row doesn't grow a tail of
          // zeroes; the built-ins always show so their absence isn't confusing.
          const isBuiltIn =
            f.slug === "all" ||
            f.slug === "enrolled" ||
            roles.find((r) => r.slug === f.slug)?.is_system;
          if (!isBuiltIn && count === 0 && !active) return null;
          const params = new URLSearchParams();
          if (f.slug !== "all") params.set("role", f.slug);
          if (search) params.set("q", search);
          const qs = params.toString();
          return (
            <Link
              key={f.slug}
              href={qs ? `/admin/students?${qs}` : "/admin/students"}
              className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
                active
                  ? "border-phosphor/30 bg-phosphor/10 text-phosphor-ink"
                  : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              {f.label} · {count}
            </Link>
          );
        })}
      </div>

      {search && (
        <p className="mt-3 text-xs text-ink-faint">
          {totalCount.toLocaleString()} result{totalCount === 1 ? "" : "s"} for{" "}
          <span className="font-medium text-ink-soft">“{search}”</span>
          {enrolledOnly
            ? " among enrolled"
            : filter !== "all"
              ? " in this role"
              : ""}
          .
        </p>
      )}

      <Card className="mt-6 !p-0 overflow-hidden">
        <StudentsBulkList
          canChangeRoles={canChangeRoles}
          roleOptions={roleOptions}
          rows={(profiles ?? []).map((p: any) => {
            const latestApp = (p.applications ?? [])[0];
            const enrollment = (p.enrollments ?? [])[0];
            const cohort = Array.isArray(enrollment?.cohort)
              ? enrollment?.cohort[0]
              : enrollment?.cohort;
            return {
              id: p.id,
              email: p.email,
              full_name: p.full_name,
              role: p.role as Role,
              created_at: p.created_at,
              latest_app_status: latestApp?.status ?? null,
              cohort_name: cohort?.name ?? null,
            };
          })}
        />
      </Card>

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between text-xs text-ink-soft">
        <span>
          Page {page} of {totalPages} · showing{" "}
          {Math.min(offset + 1, totalCount)}–
          {Math.min(offset + PAGE_SIZE, totalCount)}
        </span>
        <div className="flex gap-1">
          {page > 1 ? (
            <Link
              href={pageHref(page - 1)}
              className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 hover:bg-wash"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-ink-faint">
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </span>
          )}
          {page < totalPages ? (
            <Link
              href={pageHref(page + 1)}
              className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 hover:bg-wash"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-ink-faint">
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
