"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { AccessImpact } from "@/components/admin/role-impact";
import { ADMIN_PAGES } from "@/lib/nav-config";
import { diffRoleAccess } from "@/lib/role-impact";
import { deleteRole } from "../actions";

/**
 * Delete a custom role. `profiles.role` is a foreign key, so everyone holding
 * it has to land somewhere — the destination is picked here rather than
 * defaulted, because silently turning three interns into students is exactly
 * the kind of thing you want to have chosen on purpose. What the move does to
 * them (lib/role-impact.ts) shows under the choice.
 */
export function DeleteRole({
  slug,
  label,
  permissions,
  homePath,
  members,
  targets,
}: {
  slug: string;
  label: string;
  /** What the role being deleted holds, and where it lands its holders. */
  permissions: readonly string[];
  homePath: string | null;
  members: number;
  targets: { slug: string; label: string; permissions: readonly string[]; home_path: string | null }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [reassignTo, setReassignTo] = useState(
    targets.find((t) => t.slug === "student")?.slug ?? targets[0]?.slug ?? "",
  );
  const [error, setError] = useState<string | undefined>();
  const destination = targets.find((t) => t.slug === reassignTo);

  function run() {
    setError(undefined);
    start(async () => {
      const res = await deleteRole(slug, reassignTo);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push("/admin/roles");
      router.refresh();
    });
  }

  if (targets.length === 0) {
    return (
      <p className="text-sm text-ink-faint">
        No other role to move people to, so this one can&apos;t be deleted.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">
        {members === 0
          ? `Nobody holds ${label} right now.`
          : `${members} ${members === 1 ? "person holds" : "people hold"} ${label}. They'll be moved to the role you pick.`}
      </p>

      {!confirming ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() => setConfirming(true)}
        >
          Delete this role
        </Button>
      ) : (
        <div className="space-y-3 rounded-lg border border-red-500/40 bg-red-500/[0.04] p-4">
          <div className="sm:max-w-xs">
            <Label htmlFor="reassign-to">Move everyone to</Label>
            <Select
              id="reassign-to"
              value={reassignTo}
              onChange={(e) => setReassignTo(e.target.value)}
            >
              {targets.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          {members > 0 && destination && (
            <div>
              <p className="mb-1.5 text-xs text-ink-faint">
                Moved to {destination.label},{" "}
                {members === 1 ? "the person who holds" : `the ${members} people who hold`} {label} would:
              </p>
              <AccessImpact
                showPermissions
                diff={diffRoleAccess(permissions, destination.permissions, {
                  pages: ADMIN_PAGES,
                  home: { before: homePath, after: destination.home_path },
                })}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="danger"
              onClick={run}
              disabled={pending || !reassignTo}
            >
              {pending ? "Deleting…" : `Delete ${label}`}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
          {error && (
            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
