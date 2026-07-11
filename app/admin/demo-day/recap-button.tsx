"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { generateAndSendRecap } from "./recap-actions";
import { getActionError } from "@/lib/action-error";

export function RecapButton({
  teamId,
  existing,
}: {
  teamId: string;
  existing: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<string | null>(existing);
  const [error, setError] = useState<string | undefined>();

  function run() {
    if (
      existing &&
      !confirm("Regenerate the recap (this will email every team member again)?")
    )
      return;
    setError(undefined);
    start(async () => {
      try {
        const { summary, emailed } = await generateAndSendRecap(teamId);
        setStatus(`Sent to ${emailed} member${emailed === 1 ? "" : "s"}.`);
        router.refresh();
        // store summary so we don't have to re-fetch the team row immediately
        // for the preview block below
        void summary;
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div>
      <Button variant="secondary" size="sm" onClick={run} disabled={pending}>
        {pending
          ? "Generating…"
          : existing
            ? "Regenerate + resend recap"
            : "Generate + send Demo Day recap"}
      </Button>
      {status && (
        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">{status}</p>
      )}
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
