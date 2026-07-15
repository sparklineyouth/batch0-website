"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Textarea, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
import { fulfillFeedbackRequest } from "./actions";

/** Per-request fulfilment controls for the pass feedback inbox. */
export function RespondForm({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [response, setResponse] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function run(status: "scheduled" | "delivered" | "declined") {
    setError(undefined);
    start(async () => {
      try {
        await fulfillFeedbackRequest({ requestId, status, response });
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="mt-3 border-t border-line pt-3">
      <Label htmlFor={`resp-${requestId}`}>Your feedback (shown to the holder)</Label>
      <Textarea
        id={`resp-${requestId}`}
        rows={4}
        value={response}
        disabled={pending}
        onChange={(e) => setResponse(e.target.value)}
        placeholder="Write the feedback, or leave blank to just schedule / decline."
      />
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => run("delivered")} disabled={pending}>
          {pending ? "…" : "Mark delivered"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => run("scheduled")}
          disabled={pending}
        >
          Schedule for clinic
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => run("declined")}
          disabled={pending}
        >
          Decline (returns credit)
        </Button>
      </div>
    </div>
  );
}
