"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { deleteRole } from "../actions";

/**
 * Delete a custom role. `profiles.role` is a foreign key, so everyone holding
 * it has to land somewhere — the destination is picked here rather than
 * defaulted, because silently turning three interns into students is exactly
 * the kind of thing you want to have chosen on purpose.
 */
export function DeleteRole({
  slug,
  label,
  members,
  targets,
}: {
  slug: string;
  label: string;
  members: number;
  targets: { slug: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [reassignTo, setReassignTo] = useState(
    targets.find((t) => t.slug === "student")?.slug ?? targets[0]?.slug ?? "",
  );
  const [error, setError] = useState<string | undefined>();

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
