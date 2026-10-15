"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { resultError } from "@/components/chat/util";
import { deleteMessage } from "@/app/chat/actions";
import { resolveReport } from "@/app/chat/manage-actions";

export function ReportControls({
  reportId,
  status,
  messageId,
  chatHref,
}: {
  reportId: string;
  status: "open" | "actioned" | "dismissed";
  messageId: string | null;
  chatHref: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** Run one action; true when it worked. A failure stays on screen. */
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const res = await fn().catch(() => ({ ok: false, error: undefined }));
    setBusy(false);
    if (!res.ok) setError(resultError(res as any, "Couldn't do that."));
    router.refresh();
    return res.ok;
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {messageId ? (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirmRemove(true)}>
            Remove message
          </Button>
        ) : null}
        {status === "open" ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => run(() => resolveReport(reportId, "actioned"))}>
              Mark actioned
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => resolveReport(reportId, "dismissed"))}>
              Dismiss
            </Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => resolveReport(reportId, "open"))}>
            Reopen
          </Button>
        )}
        <ButtonLink href={chatHref} variant="ghost" size="sm">
          Open in chat
        </ButtonLink>
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">
        Removing hides the message for everyone and is logged; what it said stays here. To block someone from chat
        entirely, change their role or remove their enrollment from People.
      </p>
      {error ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      <ConfirmDialog
        open={confirmRemove}
        title="Remove this message?"
        description="It disappears for everyone. The report keeps a copy of what it said."
        confirmLabel="Remove"
        destructive
        pending={busy}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          setConfirmRemove(false);
          // A removal that failed leaves the message up, so the report stays
          // open — never closed as actioned over a message still showing.
          if (messageId && !(await run(() => deleteMessage(messageId)))) return;
          if (status === "open") await run(() => resolveReport(reportId, "actioned"));
        }}
      />
    </div>
  );
}
