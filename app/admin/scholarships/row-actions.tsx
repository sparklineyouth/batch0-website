"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
import { setScholarshipEnabled, deleteScholarship } from "./actions";

export function ScholarshipRowActions({
  id,
  name,
  enabled,
  hasApplicants,
}: {
  id: string;
  name: string;
  enabled: boolean;
  /** Anyone awarded or waiting. Deleting is refused server-side when true. */
  hasApplicants: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(undefined);
    start(async () => {
      try {
        const res = await fn();
        if (!res.ok) {
          setError(res.error);
          setConfirming(false);
          return;
        }
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
        setConfirming(false);
      }
    });
  }

  return (
    <div className="shrink-0 text-right">
      <div className="flex items-center gap-2">
        <ButtonLink size="sm" variant="secondary" href={`/admin/scholarships/${id}`}>
          Edit
        </ButtonLink>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run(() => setScholarshipEnabled(id, !enabled))}
        >
          {enabled ? "Disable" : "Enable"}
        </Button>
        {/* Deleting is hidden once anyone has applied. The server refuses it
            anyway — the FK cascades, so a delete would take awards whose money
            has already moved — but offering a button that always errors is
            worse than not offering one. */}
        {!hasApplicants &&
          (confirming ? (
            <>
              <Button
                size="sm"
                variant="danger"
                disabled={pending}
                onClick={() => run(() => deleteScholarship(id))}
              >
                {pending ? "Deleting…" : `Delete ${name}`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          ))}
      </div>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}
