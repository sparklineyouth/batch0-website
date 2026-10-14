"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError } from "@/components/ui/input";
import { reviewSubmission } from "@/app/mentor/assignments/actions";
import { getActionError } from "@/lib/action-error";
import { LIMITS } from "@/lib/assignments";

/** Feedback + "Mark reviewed" / "Return for changes". Mentor queue and admin drawer. */
export function ReviewForm({
  submissionId,
  initialFeedback,
  onDone,
}: {
  submissionId: string;
  initialFeedback?: string | null;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [feedback, setFeedback] = useState(initialFeedback ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function send(outcome: "reviewed" | "returned") {
    setError(null);
    start(async () => {
      try {
        const res = await reviewSubmission({ submissionId, feedback, outcome });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        onDone?.();
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-2">
      <Textarea
        aria-label="Feedback"
        rows={3}
        placeholder="Feedback (optional when marking reviewed)"
        value={feedback}
        maxLength={LIMITS.feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />
      <FieldError>{error}</FieldError>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => send("returned")}>
          Return for changes
        </Button>
        <Button size="sm" disabled={pending} onClick={() => send("reviewed")}>
          {pending ? "Saving…" : "Mark reviewed"}
        </Button>
      </div>
    </div>
  );
}
