"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
import { InviteForm, type InviteeOption } from "@/components/live/invite-form";
import {
  InviteList,
  splitInvitesByPhase,
} from "@/components/live/invite-card";
import { createInvite, cancelInvite } from "@/app/calls/actions";
import type { CallInvite } from "@/lib/live";
import { Plus } from "lucide-react";

/**
 * The host side of 1:1 calls, shared by /mentor/calls, /investor/calls and
 * /admin/calls.
 *
 * One component rather than three near-copies: the three panels differ only
 * in their surrounding layout and in whose invites they list, both of which
 * are decided by the server page that renders this. Behaviour that must be
 * identical everywhere — what the form validates, what cancelling does — has
 * exactly one implementation.
 *
 * Split into "Upcoming" and "Past" by `callPhase`. A call is Past once it was
 * completed, cancelled or declined — or, being accepted, once its window has
 * closed, even if nobody pressed End call. It used to stay in the one list
 * with a Cancel button, and "tidying up" a finished call with Cancel told the
 * student it was cancelled and refunded a credit it had spent. The card no
 * longer offers Cancel on a finished call, and cancelInvite refuses one.
 */
export function CallsPanel({
  invites,
  students,
  emptyMessage = "You haven't invited anyone yet.",
}: {
  invites: CallInvite[];
  students: InviteeOption[];
  emptyMessage?: string;
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  // Taken at first render and re-taken each minute, so a call that finishes
  // while the panel is open moves to Past on its own. See StudentCalls.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const split = splitInvitesByPhase(invites, now);
  // An unanswered invite is still ahead of the host; it belongs with the
  // accepted ones, in start order as the server sent them.
  const ahead = invites.filter(
    (i) => split.pending.includes(i) || split.upcoming.includes(i),
  );

  function submit(draft: {
    inviteeId: string;
    startsAt: string;
    durationMinutes: number;
    topic: string;
  }) {
    setError(undefined);
    start(async () => {
      try {
        await createInvite(draft);
        setComposing(false);
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  function cancel(id: string) {
    setError(undefined);
    start(async () => {
      try {
        await cancelInvite(id);
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  if (composing) {
    return (
      <div>
        <h2 className="mb-4 text-sm font-semibold text-ink">
          Invite a student to a 1:1
        </h2>
        <InviteForm
          students={students}
          onSubmit={submit}
          onCancel={() => setComposing(false)}
          pending={pending}
          error={error}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5 flex justify-end">
        <Button onClick={() => setComposing(true)}>
          <Plus className="h-4 w-4" /> Invite a student
        </Button>
      </div>

      <InviteList
        invites={ahead}
        perspective="host"
        emptyMessage={
          split.past.length > 0 ? "Nothing coming up." : emptyMessage
        }
        onCancel={cancel}
        pending={pending}
      />

      {split.past.length > 0 && (
        <section className="mt-8">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
            Past
          </h3>
          <InviteList
            invites={split.past}
            perspective="host"
            emptyMessage=""
            pending={pending}
          />
        </section>
      )}

      {error && (
        <p className="mt-4 text-xs text-red-700 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
