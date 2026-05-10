"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/input";
import { decideApplication, reopenApplication } from "./actions";

export function ReviewActions({
  applicationId,
  status,
  initialNotes,
}: {
  applicationId: string;
  status: string;
  initialNotes: string;
}) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function decide(decision: "accepted" | "rejected") {
    setError(undefined);
    start(async () => {
      try {
        await decideApplication(applicationId, decision, notes);
        router.refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  function reopen() {
    setError(undefined);
    start(async () => {
      try {
        await reopenApplication(applicationId);
        router.refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  const decided = status === "accepted" || status === "rejected" || status === "paid" || status === "enrolled";

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="notes">Notes (optional, visible to applicant)</Label>
        <Textarea
          id="notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={pending}
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {!decided && (
          <>
            <Button onClick={() => decide("accepted")} disabled={pending}>
              {pending ? "…" : "Accept"}
            </Button>
            <Button
              variant="danger"
              onClick={() => decide("rejected")}
              disabled={pending}
            >
              Reject
            </Button>
          </>
        )}
        {(status === "accepted" || status === "rejected") && (
          <Button variant="secondary" onClick={reopen} disabled={pending}>
            Re-open for review
          </Button>
        )}
        {(status === "paid" || status === "enrolled") && (
          <p className="text-sm text-white/50">
            Payment received. Application is locked.
          </p>
        )}
      </div>
    </div>
  );
}
