"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { getActionError } from "@/lib/action-error";
import { setChallengeStatus, deleteChallenge } from "./actions";
import type { ChallengeStatus } from "@/lib/challenges-shared";

export function ChallengeRowActions({
  id,
  status,
}: {
  id: string;
  status: ChallengeStatus;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    start(async () => {
      try {
        const res = await fn();
        if (!res.ok) {
          alert(res.error ?? "Something went wrong.");
          return;
        }
        router.refresh();
      } catch (err) {
        alert(getActionError(err));
      }
    });
  }

  const btn =
    "rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50";

  return (
    <div className="flex items-center gap-2">
      {status === "active" ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => setChallengeStatus(id, "closed"))}
          className={`${btn} border-line text-ink-soft hover:border-ink/30 hover:text-ink`}
        >
          Close
        </button>
      ) : (
        <button
          type="button"
          disabled={pending || status === "archived"}
          onClick={() => run(() => setChallengeStatus(id, "active"))}
          className={`${btn} border-spark/40 bg-spark/10 text-spark-ink hover:bg-spark/20`}
        >
          Set live
        </button>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (
            confirm(
              "Delete this challenge? If it has submissions it will be archived instead.",
            )
          ) {
            run(() => deleteChallenge(id));
          }
        }}
        className={`${btn} border-line text-ink-faint hover:border-red-400/50 hover:text-red-400`}
      >
        Delete
      </button>
    </div>
  );
}
