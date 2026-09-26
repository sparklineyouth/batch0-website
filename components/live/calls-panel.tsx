"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
import { InviteForm, type InviteeOption } from "@/components/live/invite-form";
import { CallSections } from "@/components/live/invite-card";
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
 */
export function CallsPanel({
  invites,
  students,
  now,
  recordings,
  emptyMessage = "You haven't invited anyone yet.",
}: {
  invites: CallInvite[];
  students: InviteeOption[];
  /** The server's render time (ISO) — the clock the Upcoming/Past split starts on. */
  now: string;
  /** inviteId → recorded parts, for this host's own past calls. */
  recordings?: Record<string, number>;
  emptyMessage?: string;
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

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

      <CallSections
        invites={invites}
        perspective="host"
        now={now}
        recordings={recordings}
        emptyMessage={emptyMessage}
        onCancel={cancel}
        pending={pending}
      />

      {error && (
        <p className="mt-4 text-xs text-red-700 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
