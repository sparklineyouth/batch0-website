import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { AccessImpact } from "@/components/admin/role-impact";
import { RoleForm } from "@/app/admin/roles/role-form";
import { GrantPreview } from "@/app/admin/roles/grant-form";
import { DeleteRole } from "@/app/admin/roles/[slug]/delete-role";
import { BulkPreview, StudentsBulkList } from "@/app/admin/students/bulk-list";
import { ADMIN_PAGES } from "@/lib/nav-config";
import { capabilitiesFrom } from "@/lib/permissions";
import { diffRoleAccess, previewRoleAssignment, type ImpactRole } from "@/lib/role-impact";

/**
 * Interface preview for the role impact previews (lib/role-impact.ts).
 *
 * The real pages (/admin/roles, a role's page, People) need a signed-in admin
 * and a database; this renders the same components over made-up roles and
 * people: the role editor live (tick boxes to see "What saving changes"), the
 * email form's preview card, the delete dialog's move, the bulk change's
 * dialog, and the row picker (pick a role to see its confirmation). Saving,
 * assigning or applying calls the real server actions, which refuse without
 * an admin session.
 *
 * Gated on VERCEL_ENV (not NODE_ENV, which is "production" on every Vercel
 * deployment): it renders on localhost and on branch previews, and 404s on
 * the live site.
 */
export const metadata = {
  title: "Role impact preview · batch0",
  robots: { index: false, follow: false },
};

const ROLES: ImpactRole[] = [
  { slug: "student", label: "Student", permissions: ["student.dashboard"], home_path: "/dashboard" },
  { slug: "admin", label: "Admin", permissions: ["*"], home_path: "/admin" },
  { slug: "mentor", label: "Mentor", permissions: ["mentor.panel", "calls.invite"], home_path: "/mentor" },
  { slug: "investor", label: "Investor", permissions: ["investor.panel", "calls.invite"], home_path: "/investor" },
  { slug: "finance", label: "Finance", permissions: ["payments.view", "payments.manage", "charges.manage"], home_path: "/admin" },
  { slug: "intern", label: "Intern", permissions: ["applications.view", "people.view"], home_path: "/admin" },
  {
    slug: "ops",
    label: "Ops",
    permissions: ["people.view", "people.roles", "applications.view", "mentor.panel", "calls.invite", "chat.manage"],
    home_path: "/admin",
  },
];
const COLORS: Record<string, string> = { student: "slate", admin: "phosphor", mentor: "emerald", investor: "purple", finance: "amber", intern: "sky", ops: "rose" };
const role = (slug: string) => ROLES.find((r) => r.slug === slug)!;
const ME = "00000000-0000-4000-8000-000000000001";

export default function RoleImpactPreviewPage() {
  if (process.env.VERCEL_ENV === "production") notFound();

  const ops = { userId: ME, caps: capabilitiesFrom("ops", role("ops").permissions) };
  const people = [
    { id: "u1", full_name: "Ada Lovelace", email: "ada@example.test", role: "student" },
    { id: "u2", full_name: "Grace Hopper", email: "grace@example.test", role: "student" },
    { id: "u3", full_name: "Alan Turing", email: "alan@example.test", role: "mentor" },
    { id: "u4", full_name: "Katherine Johnson", email: "kj@example.test", role: "admin" },
    { id: ME, full_name: "Sam (you)", email: "sam@example.test", role: "ops" },
    { id: "u6", full_name: "Mary Jackson", email: "mary@example.test", role: "intern" },
  ];
  const bulk = previewRoleAssignment({
    actor: ops,
    roles: ROLES,
    targets: people.map((p) => ({ id: p.id, role: p.role })),
    nextRole: "intern",
    pages: ADMIN_PAGES,
  });
  const names = Object.fromEntries(people.map((p) => [p.id, p.full_name]));
  const options = ROLES.filter((r) => ["mentor", "intern", "ops"].includes(r.slug)).map((r) => ({
    slug: r.slug,
    label: r.label,
    color: COLORS[r.slug],
  }));

  return (
    <main className="mx-auto max-w-4xl space-y-12 px-4 py-10">
      <p className="rounded-lg border border-amber-400/40 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
        Preview with made-up roles and people. Saving, assigning and applying call the real server
        actions, which need an admin session.
      </p>

      <section>
        <h2 className="mb-1 font-display text-2xl font-bold tracking-[-0.02em] text-ink">Editing the Mentor role</h2>
        <p className="mb-6 text-sm text-ink-faint">
          Tick “Manage the blog”: one admin-area key opens the whole panel, and 1:1 calls with it.
        </p>
        <RoleForm
          mode="edit"
          grantable={null}
          members={14}
          actorRole="admin"
          initial={{
            slug: "mentor",
            label: "Mentor",
            description: "",
            permissions: [...role("mentor").permissions],
            homePath: "/mentor",
            color: "emerald",
          }}
        />
      </section>

      <section className="space-y-4">
        <h2 className="font-display text-2xl font-bold tracking-[-0.02em] text-ink">Saved changes, at a glance</h2>
        {(
          [
            ["Finance loses its finance keys", role("finance").permissions, ["people.view"]],
            ["A role gains Send texts without View texting", ["people.view"], ["people.view", "sms.send"]],
            ["A role gets See confidential concerns alone", ["people.view"], ["people.view", "support.sensitive"]],
          ] as const
        ).map(([title, before, after]) => (
          <Card key={title}>
            <h3 className="mb-2 text-sm font-semibold text-ink">{title}</h3>
            <AccessImpact
              showPermissions
              showNeeds
              diff={diffRoleAccess(before, after, { pages: ADMIN_PAGES, home: { before: "/admin", after: "/admin" } })}
            />
          </Card>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-2xl font-bold tracking-[-0.02em] text-ink">Give someone a role (email form)</h2>
        <GrantPreview name="Ada Lovelace" email="ada@example.test" currentRole={role("student")} next={role("admin")} refusal={null} />
        <GrantPreview name="Mary Jackson" email="mary@example.test" currentRole={role("intern")} next={role("finance")} refusal={null} />
        <GrantPreview
          name="Katherine Johnson"
          email="kj@example.test"
          currentRole={role("admin")}
          next={role("intern")}
          refusal="Only a full admin can change a full admin's role."
        />
      </section>

      <section>
        <h2 className="mb-3 font-display text-2xl font-bold tracking-[-0.02em] text-ink">
          Bulk change to Intern, by a delegate (Ops)
        </h2>
        <Card>
          <BulkPreview preview={{ ...bulk, unseen: 0 }} names={names} />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 font-display text-2xl font-bold tracking-[-0.02em] text-ink">Deleting the Finance role</h2>
        <Card>
          <DeleteRole
            slug="finance"
            label="Finance"
            permissions={role("finance").permissions}
            homePath="/admin"
            members={3}
            targets={ROLES.filter((r) => r.slug !== "finance" && r.slug !== "admin").map((r) => ({
              slug: r.slug,
              label: r.label,
              permissions: r.permissions,
              home_path: r.home_path ?? null,
            }))}
          />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 font-display text-2xl font-bold tracking-[-0.02em] text-ink">People, as the Ops delegate</h2>
        <p className="mb-3 text-sm text-ink-faint">
          Pick a role on a row to see its confirmation; select rows and Apply for the bulk dialog.
        </p>
        <Card className="!p-0 overflow-hidden">
          <StudentsBulkList
            canChangeRoles
            actor={ops}
            impactRoles={ROLES}
            roleOptions={options}
            roleBadges={ROLES.map((r) => ({ slug: r.slug, label: r.label, color: COLORS[r.slug] }))}
            rows={people.map((p) => {
              const locked =
                p.id === ME
                  ? "You can't change your own role. Ask another admin."
                  : p.role === "admin"
                    ? "Only a full admin can change a full admin's role."
                    : null;
              return {
                ...p,
                role_locked: locked !== null,
                role_lock_reason: locked,
                created_at: "2026-09-01T12:00:00.000Z",
                latest_app_status: null,
                cohort_name: null,
              };
            })}
          />
        </Card>
      </section>
    </main>
  );
}
