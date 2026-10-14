"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
import { shareEventFiles } from "./actions";

/**
 * "Share with students" for a past webinar not shared yet: one whose email is
 * off, or one still waiting for its follow-up (`note` says what sharing now
 * changes).
 */
export function ShareFiles({ eventId, note }: { eventId: string; note?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        data-testid="share-files"
        onClick={() => {
          setError(null);
          start(async () => {
            try {
              const r = await shareEventFiles(eventId);
              if (!r.ok) throw new Error(r.error || "Try again.");
              router.refresh();
            } catch (err) {
              setError(getActionError(err));
            }
          });
        }}
      >
        {pending ? "Sharing…" : "Share with students"}
      </Button>
      {error ? (
        <span className="text-xs text-red-700 dark:text-red-400">{error}</span>
      ) : (
        <span className="text-xs text-ink-faint">
          {note ?? "Students can\u2019t watch it until it\u2019s shared. No email is sent."}
        </span>
      )}
    </div>
  );
}
