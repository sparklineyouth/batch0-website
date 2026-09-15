"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Lock, LockOpen, Pin, PinOff, RotateCcw, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { getActionError } from "@/lib/action-error";
import {
  deleteThread,
  setThreadPinned,
  setThreadStatus,
} from "@/app/admin/discussions/actions";
import type { DiscussionStatus, DiscussionVisibility } from "@/lib/discussions-access";

/**
 * The team's controls on a thread: resolve/reopen a question, lock/unlock or
 * pin/unpin a discussion, delete either. Rendered into ThreadView's
 * `controls` slot on the admin thread page.
 */
export function AdminThreadControls({
  threadId,
  title,
  visibility,
  status,
  pinned,
}: {
  threadId: string;
  title: string;
  visibility: DiscussionVisibility;
  status: DiscussionStatus;
  pinned: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const closed = status === "closed";
  const isPrivate = visibility === "admin";

  function run(fn: () => Promise<unknown>, after?: () => void) {
    setErr(undefined);
    start(async () => {
      try {
        await fn();
        after ? after() : router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <>
      {err && <span className="self-center text-xs text-red-700 dark:text-red-300">{err}</span>}
      {!isPrivate && (
        <Ctl
          disabled={pending}
          onClick={() => run(() => setThreadPinned({ threadId, pinned: !pinned }))}
          icon={pinned ? PinOff : Pin}
          label={pinned ? "Unpin" : "Pin"}
        />
      )}
      <Ctl
        disabled={pending}
        onClick={() =>
          run(() => setThreadStatus({ threadId, status: closed ? "open" : "closed" }))
        }
        icon={closed ? (isPrivate ? RotateCcw : LockOpen) : isPrivate ? CheckCircle2 : Lock}
        label={closed ? (isPrivate ? "Reopen" : "Unlock") : isPrivate ? "Resolve" : "Lock"}
      />
      <Ctl
        disabled={pending}
        onClick={() => setConfirmDelete(true)}
        icon={Trash2}
        label="Delete"
        danger
      />
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete "${title}"?`}
        destructive
        confirmLabel="Delete thread"
        pending={pending}
        onCancel={() => !pending && setConfirmDelete(false)}
        onConfirm={() =>
          run(
            () => deleteThread({ threadId }),
            () => {
              setConfirmDelete(false);
              router.push("/admin/discussions");
              router.refresh();
            },
          )
        }
        description={
          <p className="text-left text-sm text-ink-soft">
            Removes the thread and every reply on it, and clears the bells that
            pointed at it. {isPrivate ? "The student" : "The cohort"} won't be
            told. This can't be undone.
          </p>
        }
      />
    </>
  );
}

function Ctl({
  onClick,
  disabled,
  icon: Icon,
  label,
  danger = false,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: typeof Pin;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`press inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-ink-soft disabled:opacity-50 ${
        danger
          ? "hover:border-red-400/50 hover:text-red-700 dark:hover:text-red-300"
          : "hover:border-ink/30 hover:text-ink"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
