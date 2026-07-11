"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { getActionError } from "@/lib/action-error";
import { deleteAnnouncement } from "./actions";

export function DeleteAnnouncementButton({
  id,
  title,
}: {
  id: string;
  title: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();

  function onConfirm() {
    setErr(undefined);
    start(async () => {
      try {
        await deleteAnnouncement(id);
        setOpen(false);
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-ink-soft hover:border-red-400/50 hover:text-red-700 dark:hover:text-red-300"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete
      </button>
      <ConfirmDialog
        open={open}
        title={`Delete "${title}"?`}
        destructive
        confirmLabel="Delete"
        pending={pending}
        onCancel={() => !pending && setOpen(false)}
        onConfirm={onConfirm}
        description={
          <div className="text-left">
            <p className="text-sm text-ink-soft">
              Removes the announcement and any deep-links that point at
              it. Reactions are deleted with it.
            </p>
            {err && (
              <p className="mt-2 text-xs text-red-700 dark:text-red-300">{err}</p>
            )}
          </div>
        }
      />
    </>
  );
}
