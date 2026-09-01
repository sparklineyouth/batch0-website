"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { changeUserRole } from "./actions";
import { roleColorClasses } from "@/lib/permissions";
import type { Role } from "@/lib/types";
import { getActionError } from "@/lib/action-error";

export type RoleOption = { slug: string; label: string; color: string };

/**
 * Inline role picker. Options come from `public.app_roles` via the page, so a
 * role created at /admin/roles is assignable here the moment it exists.
 */
export function RoleSelect({
  userId,
  role,
  options,
}: {
  userId: string;
  role: Role;
  options: RoleOption[];
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<Role>(role);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  // A profile can point at a role that was just deleted, or one this page's
  // options were filtered down from. Keep it selectable so the picker shows
  // the truth rather than silently displaying the wrong role.
  const known = options.some((o) => o.slug === current);
  const list = known
    ? options
    : [...options, { slug: current, label: current, color: "slate" }];
  const color = list.find((o) => o.slug === current)?.color ?? "slate";

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as Role;
    if (next === current) return;
    const previous = current;
    setCurrent(next);
    setError(undefined);
    start(async () => {
      try {
        await changeUserRole(userId, next);
        router.refresh();
      } catch (err: any) {
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
      </select>
      {error && <span className="text-[10px] text-red-700 dark:text-red-300">{error}</span>}
    </div>
  );
}
