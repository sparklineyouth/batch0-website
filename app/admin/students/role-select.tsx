"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { changeUserRole } from "./actions";
import { roleColorClasses } from "@/lib/permissions";
import { ADMIN_PAGES } from "@/lib/nav-config";
import { diffRoleAccess, type ImpactRole } from "@/lib/role-impact";
import { AccessImpact } from "@/components/admin/role-impact";
import { ConfirmDialog } from "@/components/ui/dialog";
import type { Role } from "@/lib/types";
import { getActionError } from "@/lib/action-error";

export type RoleOption = { slug: string; label: string; color: string };

/**
 * Inline role picker. Options come from `public.app_roles` via the page, so a
 * role created at /admin/roles is assignable here the moment it exists.
 *
 * Picking a role asks first, with what this person would gain or lose next to
 * the role they hold now (lib/role-impact.ts). Roles the viewer can't hand
 * out are listed but disabled, saying why, rather than missing.
 */
export function RoleSelect({
  userId,
  role,
  options,
  roles,
  name,
}: {
  userId: string;
  role: Role;
  /** The roles the viewer may hand out. */
  options: RoleOption[];
  /** Every role with what it holds, for the preview and the disabled options. */
  roles: ImpactRole[];
  /** Who this is, for the confirmation's title. */
  name?: string | null;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<Role>(role);
  const [choice, setChoice] = useState<Role | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  // A profile can point at a role that was just deleted, or one this page's
  // options were filtered down from. Keep it selectable so the picker shows
  // the truth rather than silently displaying the wrong role.
  const known = options.some((o) => o.slug === current);
  const list = known
    ? options
    : [...options, { slug: current, label: roles.find((r) => r.slug === current)?.label ?? current, color: "slate" }];
  const color = options.find((o) => o.slug === current)?.color ?? "slate";
  const unavailable = roles.filter((r) => !list.some((o) => o.slug === r.slug));

  const from = roles.find((r) => r.slug === current);
  const to = choice ? roles.find((r) => r.slug === choice) : undefined;

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as Role;
    if (next === current) return;
    setError(undefined);
    // The select stays on the current role until the change is confirmed.
    setChoice(next);
  }

  function confirm() {
    if (!choice) return;
    const next = choice;
    const previous = current;
    setCurrent(next);
    start(async () => {
      try {
        // Refusals (your own role, someone with admin powers you don't hold,
        // the last full admin) come back as results so the real reason shows.
        const res = await changeUserRole(userId, next);
        setChoice(null);
        if (!res.ok) {
          setCurrent(previous);
          setError(res.error);
          return;
        }
        router.refresh();
      } catch (err: any) {
        setChoice(null);
        setCurrent(previous);
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        value={current}
        disabled={pending}
        onChange={onChange}
        aria-label="Change role"
        className={`appearance-none rounded-full border bg-transparent px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider focus:outline-none focus:ring-1 focus:ring-phosphor/40 ${roleColorClasses(
          color,
        )} ${pending ? "opacity-50" : ""}`}
      >
        {list.map((r) => (
          <option key={r.slug} value={r.slug} className="bg-paper text-ink">
            {r.label}
          </option>
        ))}
        {unavailable.map((r) => (
          <option key={r.slug} value={r.slug} disabled className="bg-paper text-ink-faint">
            {r.label} (holds permissions you don&apos;t)
          </option>
        ))}
      </select>
      {error && <span className="text-[10px] text-red-700 dark:text-red-300">{error}</span>}

      <ConfirmDialog
        open={choice !== null}
        title={`Change ${name || "this person"} to ${to?.label ?? choice}?`}
        confirmLabel="Change role"
        pending={pending}
        onCancel={() => !pending && setChoice(null)}
        onConfirm={confirm}
        description={
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            <p className="text-xs text-ink-faint">
              They hold {from?.label ?? current} now. As {to?.label ?? choice}, they would:
            </p>
            <AccessImpact
              showPermissions
              diff={diffRoleAccess(from?.permissions ?? [], to?.permissions ?? [], {
                pages: ADMIN_PAGES,
                home: { before: from?.home_path ?? null, after: to?.home_path ?? null },
              })}
            />
            <p className="text-xs text-ink-faint">Their access changes right away.</p>
          </div>
        }
      />
    </div>
  );
}
