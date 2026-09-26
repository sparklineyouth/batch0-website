"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { getActionError } from "@/lib/action-error";
import { setChallengeStatus, deleteChallenge, duplicateChallenge } from "./actions";
import type { ChallengeStatus } from "@/lib/challenges-shared";

export function ChallengeRowActions({
  id,
  status,
  compact = false,
}: {
  id: string;
  status: ChallengeStatus;
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string; data?: any }>, after?: (data: any) => void) {
    start(async () => {
      try {
        const res = await fn();
        if (!res.ok) {
          alert(res.error ?? "Something went wrong.");
          return;
        }
        if (after) after(res.data);
        else router.refresh();
      } catch (err) {
        alert(getActionError(err));
      }
    });
  }

  const btn = "rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50";
  const quiet = `${btn} border-line text-ink-soft hover:border-ink/30 hover:text-ink`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "active" ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (confirm("Close it? The page stays up, but nobody can register or submit.")) {
              run(() => setChallengeStatus(id, "closed"));
            }
          }}
          className={quiet}
        >
          Close
        </button>
      ) : status === "archived" ? (
        <button type="button" disabled={pending} onClick={() => run(() => setChallengeStatus(id, "closed"))} className={quiet}>
          Unarchive
        </button>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (status === "draft" || confirm("Reopen it? Registration and submissions will reopen until the deadline.")) {
              run(() => setChallengeStatus(id, "active"));
            }
          }}
          className={`${btn} border-phosphor bg-phosphor text-on-phosphor hover:bg-phosphor-200`}
        >
          {status === "draft" ? "Publish" : "Reopen"}
        </button>
      )}
      {status === "active" && !compact && (
        <button type="button" disabled={pending} onClick={() => run(() => setChallengeStatus(id, "draft"))} className={quiet}>
          Unpublish
        </button>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => duplicateChallenge(id), (d) => router.push(`/admin/challenges/${d.id}/edit`))}
        className={quiet}
      >
        Duplicate
      </button>
      {!compact && status !== "archived" && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (confirm("Delete this challenge? If anyone registered or submitted, it's archived instead.")) {
              run(() => deleteChallenge(id), () => router.push("/admin/challenges"));
            }
          }}
          className={`${btn} border-line text-ink-faint hover:border-red-400/50 hover:text-red-500`}
        >
          Delete
        </button>
      )}
    </div>
  );
}
