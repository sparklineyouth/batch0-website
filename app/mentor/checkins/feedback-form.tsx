"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError } from "@/components/ui/input";
import { postCheckinFeedback } from "@/app/dashboard/checkin/actions";
import { getActionError } from "@/lib/action-error";

export function CheckinFeedbackForm({ checkinId }: { checkinId: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function submit() {
    setError(undefined);
    start(async () => {
      try {
        await postCheckinFeedback(checkinId, body);
        setBody("");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="mt-3 rounded-lg border border-line bg-paper p-3">
      <Textarea
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Leave feedback for this check-in…"
      />
      <FieldError>{error}</FieldError>
      <div className="mt-2 flex justify-end">
        <Button onClick={submit} disabled={pending || !body.trim()} size="sm">
          {pending ? "Posting…" : "Post feedback"}
        </Button>
      </div>
    </div>
  );
}
