"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { getActionError } from "@/lib/action-error";
import { roomWindow, webinarHasBegun } from "@/lib/live";
import { endLive, reopenLive } from "@/app/dashboard/events/[id]/live/room-actions";

/**
 * End for everyone / Reopen, from outside the room — the room's own actions,
 * so the rules match: End once the webinar has begun, Reopen after an End,
 * both until the room's hard close.
 */
export function LiveControls({
  eventId,
  startsAt,
  endsAt,
  liveStartedAt,
  liveEndedAt,
  now,
}: {
  eventId: string;
  startsAt: string;
  endsAt: string | null;
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  /** ISO; the server's clock for this render. */
  now: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const t = new Date(now).getTime();
  const open = t <= roomWindow(startsAt, endsAt).hardCloseAt;
  const canEnd = !liveEndedAt && open && webinarHasBegun(startsAt, liveStartedAt, t);
  const canReopen = !!liveEndedAt && open;

  function run(action: () => Promise<unknown>) {
    setError(null);
    start(async () => {
      try {
        const r = await action();
        // Tolerates both shapes: a throwing action and an ActionResult.
        if (r && typeof r === "object" && (r as { ok?: boolean }).ok === false) {
          throw new Error((r as { error?: string }).error || "Try again.");
        }
        setConfirmEnd(false);
        router.refresh();
      } catch (err) {
        setConfirmEnd(false);
        setError(getActionError(err));
      }
    });
  }

  if (!canEnd && !canReopen) return null;

  return (
    <>
      {canEnd && (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => setConfirmEnd(true)}>
          End
        </Button>
      )}
      {canReopen && (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => reopenLive(eventId))}>
          {pending ? "Reopening…" : "Reopen"}
        </Button>
      )}
      {error && <span className="basis-full text-right text-xs text-red-700 dark:text-red-400">{error}</span>}
      <ConfirmDialog
        open={confirmEnd}
        title="End for everyone?"
        description={<p>Everyone in the room is disconnected. You can reopen it.</p>}
        confirmLabel="End for everyone"
        cancelLabel="Keep it running"
        destructive
        pending={pending}
        onConfirm={() => run(() => endLive(eventId))}
        onCancel={() => !pending && setConfirmEnd(false)}
      />
    </>
  );
}
