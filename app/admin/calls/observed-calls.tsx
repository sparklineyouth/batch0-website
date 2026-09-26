"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { InviteList } from "@/components/live/invite-card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { getActionError } from "@/lib/action-error";
import { cancelInvite } from "@/app/calls/actions";
import type { CallInvite } from "@/lib/live";

/**
 * The safeguarding list on /admin/calls: every 1:1 someone else booked.
 *
 * Read-only by default, and deliberately so. A 1:1 has exactly two people in
 * it, and an admin who is not one of them can never enter — not as a host,
 * not as a silent observer — so the cards use the `observer` perspective:
 * both names, the time, the status, and no Join (the room would 404 anyway)
 * and no calendar link. An admin who books a call is its owner and sees it in
 * their own panel above, with Join and End call.
 *
 * The one control is Cancel, and only for a superAdmin (`canCancel`, decided
 * by the server page). It is the escalation path — "this call should not
 * happen" — and it is real: cancelInvite accepts a superAdmin, and cancelling a
 * call that is in progress disconnects both people ("This call was
 * cancelled"). That is why it is confirmed first and says so. It used to be a
 * Cancel button rendered with no handler, which did nothing at all.
 */
export function ObservedCalls({
  invites,
  canCancel,
}: {
  invites: CallInvite[];
  canCancel: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const target = invites.find((i) => i.id === confirmId) ?? null;

  function cancel(id: string) {
    setError(undefined);
    start(async () => {
      try {
        await cancelInvite(id);
        setConfirmId(null);
        router.refresh();
      } catch (err: any) {
        setConfirmId(null);
        setError(getActionError(err));
      }
    });
  }

  return (
    <>
      <InviteList
        invites={invites}
        perspective="observer"
        emptyMessage="Nobody else has booked a 1:1 yet."
        // Omitted, not a no-op, when the viewer may not cancel: the card
        // renders Cancel only when it is handed something to call.
        onCancel={canCancel ? setConfirmId : undefined}
        pending={pending}
      />
      {error && (
        <p className="mt-4 text-xs text-red-700 dark:text-red-400">{error}</p>
      )}

      <ConfirmDialog
        open={confirmId !== null}
        title="Cancel someone else’s call?"
        description={
          target ? (
            <p>
              {target.hostName} ({target.hostRole}) with {target.inviteeName}.{" "}
              Both of them are told it was cancelled, and if the call is
              happening right now it ends for both of them. This can&rsquo;t
              be undone.
            </p>
          ) : null
        }
        confirmLabel="Cancel the call"
        cancelLabel="Keep it"
        destructive
        pending={pending}
        onConfirm={() => confirmId && cancel(confirmId)}
        onCancel={() => !pending && setConfirmId(null)}
      />
    </>
  );
}
