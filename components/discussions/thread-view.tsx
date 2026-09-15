"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, Pin, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import { replyToThread } from "@/app/dashboard/discussions/actions";
import { deleteReply } from "@/app/admin/discussions/actions";
import {
  closedLabel,
  THREAD_BODY_MAX,
  type DiscussionStatus,
  type DiscussionVisibility,
} from "@/lib/discussions-access";

/**
 * What a thread page renders, whoever is looking at it. The student page and
 * the admin page both mount this; they differ only in the header around it
 * and in the `canModerate` / `controls` they pass. Serialisable props only —
 * the author's email is deliberately not in the shape, so the student page
 * can't leak it by accident.
 */

export type ThreadViewThread = {
  id: string;
  title: string;
  body: string;
  authorId: string;
  authorName: string;
  isStaff: boolean;
  visibility: DiscussionVisibility;
  status: DiscussionStatus;
  pinned: boolean;
  cohortName: string | null;
  createdAt: string;
};

export type ThreadViewReply = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  isStaff: boolean;
  createdAt: string;
};

export function ThreadView({
  thread,
  replies,
  viewerId,
  canModerate = false,
  controls,
}: {
  thread: ThreadViewThread;
  replies: ThreadViewReply[];
  viewerId: string;
  /** Holds discussions.manage: shows delete on each reply. */
  canModerate?: boolean;
  /** Rendered beside the status line — resolve / lock / pin buttons. */
  controls?: React.ReactNode;
}) {
  const closed = thread.status === "closed";
  const isPrivate = thread.visibility === "admin";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {isPrivate ? (
          <Tag tone="phosphor">
            <ShieldCheck className="h-3 w-3" />
            Private · you and the batch0 team
          </Tag>
        ) : (
          <Tag tone="muted">{thread.cohortName ?? "Cohort"} · discussion</Tag>
        )}
        {thread.pinned && (
          <Tag tone="muted">
            <Pin className="h-3 w-3" />
            Pinned
          </Tag>
        )}
        {closed && (
          <Tag tone="muted">
            <Lock className="h-3 w-3" />
            {closedLabel(thread.visibility)}
          </Tag>
        )}
        {controls && <div className="ml-auto flex flex-wrap gap-2">{controls}</div>}
      </div>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink md:text-3xl">
        {thread.title}
      </h1>

      <article className="mt-5 rounded-xl border border-line bg-wash p-5">
        <Byline
          name={thread.authorName}
          isStaff={thread.isStaff}
          isYou={thread.authorId === viewerId}
          at={thread.createdAt}
        />
        <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">
          {thread.body}
        </p>
      </article>

      <h2 className="mt-8 text-[11px] font-mono font-medium uppercase tracking-[0.2em] text-ink-faint">
        {replies.length === 0
          ? "No replies yet"
          : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
      </h2>

      {replies.length > 0 && (
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {replies.map((r) => (
            <li key={r.id} className="py-4">
              <div className="flex items-start justify-between gap-3">
                <Byline
                  name={r.authorName}
                  isStaff={r.isStaff}
                  isYou={r.authorId === viewerId}
                  at={r.createdAt}
                />
                {canModerate && <DeleteReplyButton replyId={r.id} />}
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
                {r.body}
              </p>
            </li>
          ))}
        </ul>
      )}

      {closed ? (
        <p className="mt-6 flex items-center gap-2 text-sm text-ink-faint">
          <Lock className="h-3.5 w-3.5" />
          {isPrivate
            ? "This question is resolved. Reopen it to keep going."
            : "This discussion is locked — no new replies."}
        </p>
      ) : (
        <ReplyComposer threadId={thread.id} isPrivate={isPrivate} />
      )}
    </div>
  );
}

function Tag({
  tone,
  children,
}: {
  tone: "phosphor" | "muted";
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono font-medium uppercase tracking-wider ${
        tone === "phosphor"
          ? "bg-phosphor/15 text-phosphor-ink"
          : "border border-line text-ink-faint"
      }`}
    >
      {children}
    </span>
  );
}

function Byline({
  name,
  isStaff,
  isYou,
  at,
}: {
  name: string;
  isStaff: boolean;
  isYou: boolean;
  at: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div
        aria-hidden
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          isStaff ? "bg-phosphor text-on-phosphor" : "bg-ink text-paper"
        }`}
      >
        {name.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium text-ink">{name}</span>
          {isStaff && (
            <span className="text-[10px] font-mono font-medium uppercase tracking-wider text-phosphor-ink">
              batch0 team
            </span>
          )}
          {isYou && !isStaff && (
            <span className="text-[10px] font-mono uppercase tracking-wider text-ink-faint">
              you
            </span>
          )}
        </p>
        <p className="text-[11px] text-ink-faint">
          <LocalTime value={at} mode="datetime-short" />
        </p>
      </div>
    </div>
  );
}

function ReplyComposer({
  threadId,
  isPrivate,
}: {
  threadId: string;
  isPrivate: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();

  function send() {
    setErr(undefined);
    const text = body.trim();
    if (!text) return;
    start(async () => {
      try {
        await replyToThread({ threadId, body: text });
        setBody("");
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <div className="mt-6">
      <label htmlFor="reply-body" className="sr-only">
        Your reply
      </label>
      <Textarea
        id="reply-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={isPrivate ? "Reply to the thread…" : "Add to the discussion…"}
        maxLength={THREAD_BODY_MAX}
        rows={4}
        error={err}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <FieldError id="reply-body-error">{err}</FieldError>
        <Button size="sm" onClick={send} disabled={pending || !body.trim()}>
          {pending ? "Posting…" : "Reply"}
        </Button>
      </div>
    </div>
  );
}

function DeleteReplyButton({ replyId }: { replyId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);

  function run() {
    start(async () => {
      try {
        await deleteReply({ replyId });
        router.refresh();
      } catch (e) {
        // Surface in the console; a failed moderation delete is rare and the
        // row is still there to try again.
        console.error(getActionError(e));
      } finally {
        setConfirm(false);
      }
    });
  }

  if (confirm) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs">
        <button
          type="button"
          disabled={pending}
          onClick={run}
          className="rounded-md border border-red-400/50 px-2 py-1 text-red-700 hover:bg-red-400/10 dark:text-red-300"
        >
          {pending ? "Deleting…" : "Delete"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirm(false)}
          className="px-1 text-ink-faint hover:text-ink"
        >
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setConfirm(true)}
      aria-label="Delete reply"
      className="shrink-0 rounded-md p-1 text-ink-faint hover:bg-wash hover:text-red-700 dark:hover:text-red-300"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}
