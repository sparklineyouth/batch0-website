"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { postLessonComment, deleteLessonComment } from "./comments-actions";
import { MessageSquare, Trash2, CornerDownRight } from "lucide-react";
import { getActionError } from "@/lib/action-error";

type CommentRow = {
  id: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  created_at: string;
  author: { full_name: string | null; email: string; role: string };
};

type Tree = CommentRow & { replies: Tree[] };

function buildTree(rows: CommentRow[]): Tree[] {
  const byId = new Map<string, Tree>();
  rows.forEach((r) => byId.set(r.id, { ...r, replies: [] }));
  const roots: Tree[] = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function Comments({
  lessonId,
  initial,
  currentUserId,
  isStaff,
}: {
  lessonId: string;
  initial: CommentRow[];
  currentUserId: string;
  isStaff: boolean;
}) {
  const tree = buildTree(initial);
  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-faint">
        <MessageSquare className="h-3.5 w-3.5" />
        Discussion ({initial.length})
      </div>
      <Composer lessonId={lessonId} parentId={null} placeholder="Ask a question or share what you learned…" />
      <ul className="mt-6 space-y-4">
        {tree.length === 0 && (
          <li className="text-sm text-ink-faint">
            Be the first to comment.
          </li>
        )}
        {tree.map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            lessonId={lessonId}
            currentUserId={currentUserId}
            isStaff={isStaff}
          />
        ))}
      </ul>
    </div>
  );
}

function CommentItem({
  comment,
  lessonId,
  currentUserId,
  isStaff,
  depth = 0,
}: {
  comment: Tree;
  lessonId: string;
  currentUserId: string;
  isStaff: boolean;
  depth?: number;
}) {
  const router = useRouter();
  const [replying, setReplying] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [pending, start] = useTransition();
  const canDelete = comment.user_id === currentUserId || isStaff;

  function executeDelete() {
    start(async () => {
      try {
        await deleteLessonComment(comment.id);
        setConfirmDel(false);
        router.refresh();
      } catch {}
    });
  }

  return (
    <li className={depth > 0 ? "ml-6 border-l border-line pl-4" : ""}>
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-ink">
          {comment.author?.full_name || comment.author?.email || "—"}
        </span>
        {comment.author?.role && comment.author.role !== "student" && (
          <span className="rounded-full bg-spark/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-spark-ink">
            {comment.author.role}
          </span>
        )}
        <span className="text-xs text-ink-faint">
          <LocalTime value={comment.created_at} />
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-ink-soft">
        {comment.body}
      </p>
      <div className="mt-2 flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => setReplying((v) => !v)}
          className="inline-flex items-center gap-1 text-ink-faint hover:text-ink"
        >
          <CornerDownRight className="h-3 w-3" /> Reply
        </button>
        {canDelete && (
          <button
            type="button"
            onClick={() => setConfirmDel(true)}
            className="inline-flex items-center gap-1 text-ink-faint hover:text-red-600 dark:hover:text-red-400"
          >
            <Trash2 className="h-3 w-3" /> Delete
          </button>
        )}
      </div>
      {replying && (
        <div className="mt-3">
          <Composer
            lessonId={lessonId}
            parentId={comment.id}
            onDone={() => setReplying(false)}
            autoFocus
          />
        </div>
      )}
      {comment.replies.length > 0 && (
        <ul className="mt-4 space-y-4">
          {comment.replies.map((r) => (
            <CommentItem
              key={r.id}
              comment={r}
              lessonId={lessonId}
              currentUserId={currentUserId}
              isStaff={isStaff}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirmDel}
        title="Delete comment?"
        description={<p>This comment and any replies under it will be removed.</p>}
        confirmLabel="Delete"
        destructive
        pending={pending}
        onConfirm={executeDelete}
        onCancel={() => !pending && setConfirmDel(false)}
      />
    </li>
  );
}

function Composer({
  lessonId,
  parentId,
  placeholder = "Reply…",
  onDone,
  autoFocus,
}: {
  lessonId: string;
  parentId: string | null;
  placeholder?: string;
  onDone?: () => void;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function send() {
    if (!body.trim()) return;
    setError(undefined);
    start(async () => {
      try {
        await postLessonComment({ lessonId, parentId, body });
        setBody("");
        onDone?.();
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div>
      <Textarea
        rows={3}
        autoFocus={autoFocus}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
      />
      <div className="mt-2 flex items-center justify-between">
        {error ? (
          <span className="text-xs text-red-700 dark:text-red-300">{error}</span>
        ) : (
          <span />
        )}
        <Button size="sm" onClick={send} disabled={pending || !body.trim()}>
          {pending ? "Posting…" : "Post"}
        </Button>
      </div>
    </div>
  );
}
