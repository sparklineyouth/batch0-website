"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { Trash2, MessageSquare } from "lucide-react";
import { addReviewComment, deleteReviewComment } from "./comment-actions";
import { getActionError } from "@/lib/action-error";

type Comment = {
  id: string;
  body: string;
  created_at: string;
  author_id: string | null;
  author: { email: string | null; full_name: string | null } | null;
};

export function ReviewThread({
  applicationId,
  currentUserId,
  comments,
}: {
  applicationId: string;
  currentUserId: string;
  comments: Comment[];
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();

  function submit() {
    setErr(undefined);
    start(async () => {
      try {
        await addReviewComment({ applicationId, body });
        setBody("");
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  function remove(commentId: string) {
    if (!confirm("Delete this comment? Other reviewers will lose context."))
      return;
    setErr(undefined);
    start(async () => {
      try {
        await deleteReviewComment({ commentId, applicationId });
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-ink-faint">
        <MessageSquare className="h-3.5 w-3.5" />
        Reviewer notes ({comments.length})
      </div>
      <p className="text-xs text-ink-faint">
        Internal-only thread for reviewers. Applicant never sees these.
      </p>

      {comments.length === 0 ? (
        <p className="rounded-lg border border-line bg-wash px-4 py-3 text-sm text-ink-faint">
          No reviewer notes yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => {
            const author =
              c.author?.full_name ||
              c.author?.email ||
              (c.author_id ? `${c.author_id.slice(0, 8)}…` : "deleted user");
            const mine = c.author_id === currentUserId;
            return (
              <li
                key={c.id}
                className="rounded-lg border border-line bg-wash px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-xs text-ink-soft">
                    <span className="font-medium text-ink">{author}</span>
                    <span className="ml-2 text-ink-faint font-mono tabular-nums">
                      <LocalTime value={c.created_at} mode="datetime-short" />
                    </span>
                  </div>
                  {mine && (
                    <button
                      type="button"
                      onClick={() => remove(c.id)}
                      disabled={pending}
                      aria-label="Delete comment"
                      className="text-ink-faint hover:text-red-700 dark:hover:text-red-300 disabled:opacity-30"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-ink-soft">
                  {c.body}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <div className="border-t border-line pt-4">
        <Textarea
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a note for other reviewers…"
          disabled={pending}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <FieldError>{err}</FieldError>
          <Button
            size="sm"
            onClick={submit}
            disabled={pending || !body.trim()}
            className="ml-auto"
          >
            {pending ? "Posting…" : "Post note"}
          </Button>
        </div>
      </div>
    </div>
  );
}
