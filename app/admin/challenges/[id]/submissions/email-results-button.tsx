"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { getActionError } from "@/lib/action-error";
import { emailChallengeResults } from "../../actions";

/**
 * "Email results": tells every entrant who hasn't heard yet how it went.
 * Safe to press again — each entrant is emailed at most once.
 */
export function EmailResultsButton({
  challengeId,
  pending: pendingCount,
  winnersPublished,
}: {
  challengeId: string;
  pending: number;
  winnersPublished: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (!winnersPublished) {
    return (
      <span className="text-xs text-ink-faint" title="Turn on Publish winners in the editor first">
        Results email unlocks when winners are published
      </span>
    );
  }
  if (pendingCount === 0) {
    return <span className="text-xs text-ink-faint">✓ Every entrant has been emailed their result</span>;
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (!confirm(`Email results to ${pendingCount} entrant${pendingCount === 1 ? "" : "s"}? Winners get a "you won" email; everyone else gets "results are in".`)) return;
          setMsg(null);
          start(async () => {
            try {
              const res = await emailChallengeResults(challengeId);
              if (!res.ok) {
                setMsg(res.error);
                return;
              }
              setMsg(
                `Sent ${res.data?.sent ?? 0}${res.data?.failed ? `, ${res.data.failed} failed (press again to retry)` : ""}.`,
              );
              router.refresh();
            } catch (err) {
              setMsg(getActionError(err));
            }
          });
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-phosphor bg-phosphor px-3 py-1.5 text-xs font-semibold text-on-phosphor hover:bg-phosphor-200 disabled:opacity-50"
      >
        <Mail className="h-3.5 w-3.5" />
        {busy ? "Sending…" : `Email results (${pendingCount})`}
      </button>
      {msg && <span className="text-xs text-ink-soft">{msg}</span>}
    </span>
  );
}
