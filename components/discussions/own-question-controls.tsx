"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, RotateCcw } from "lucide-react";
import { getActionError } from "@/lib/action-error";
import { setOwnQuestionStatus } from "@/app/dashboard/discussions/actions";
import type { DiscussionStatus } from "@/lib/discussions-access";

/** The asker's one control on their own private question: resolved or not. */
export function OwnQuestionControls({
  threadId,
  status,
}: {
  threadId: string;
  status: DiscussionStatus;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();
  const closed = status === "closed";

  function toggle() {
    setErr(undefined);
    start(async () => {
      try {
        await setOwnQuestionStatus({
          threadId,
          status: closed ? "open" : "closed",
        });
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <span className="flex items-center gap-2">
      {err && <span className="text-xs text-red-700 dark:text-red-300">{err}</span>}
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className="press inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-ink-soft hover:border-ink/30 hover:text-ink disabled:opacity-50"
      >
        {closed ? (
          <>
            <RotateCcw className="h-3.5 w-3.5" />
            {pending ? "Reopening…" : "Reopen"}
          </>
        ) : (
          <>
            <CheckCircle2 className="h-3.5 w-3.5" />
            {pending ? "Saving…" : "Mark resolved"}
          </>
        )}
      </button>
    </span>
  );
}
