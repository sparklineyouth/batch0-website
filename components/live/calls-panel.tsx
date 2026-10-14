"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
import {
  InviteForm,
  type InviteDraft,
  type InviteeOption,
} from "@/components/live/invite-form";
import { CallSections } from "@/components/live/invite-card";
import { createInvite, cancelInvite } from "@/app/calls/actions";
import type { CallInvite } from "@/lib/live";
import { Plus } from "lucide-react";

/**
 * The staff side of 1:1 calls — calls this person sent, and calls they were
 * added to as a co-host — shared by /mentor/calls, /investor/calls and
 * /admin/calls.
 *
 * One component rather than three near-copies: the three panels differ only
 * in their surrounding layout and in whose invites they list, both of which
 * are decided by the server page that renders this. Behaviour that must be
 * identical everywhere — what the form validates, what cancelling does, who
 * can be added to a call already booked — has exactly one implementation.
 */
export function CallsPanel({
  invites,
  students,
  staff = [],
  now,
  emptyMessage = "You haven't invited anyone yet.",
}: {
  invites: CallInvite[];
  students: InviteeOption[];
  /**
   * Admins, mentors and investors who can be added as co-hosts (not the
   * viewer): on a new invite, and with Add people on any call listed here
   * that can still happen. Each card leaves out whoever is already on it.
   */
  staff?: InviteeOption[];
  /** The server's render time (ISO) — the clock the Upcoming/Past split starts on. */
  now: string;
  emptyMessage?: string;
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function submit(draft: InviteDraft) {
    setError(undefined);
    start(async () => {
      try {
        // Refusals come back as a result, with the sentence intact — see
        // createInvite.
        const result = await createInvite(draft);
        if (!result.ok) {
          setError(result.error);
          return;
        }
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
          staff={staff}
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

      {/* Add people runs from the card itself (components/live/add-to-call.tsx),
          with its own pending state and its error on that card: this panel's
          one error line, below, could not say which call a refusal was for. */}
      <CallSections
        invites={invites}
        perspective="host"
        now={now}
        emptyMessage={emptyMessage}
        onCancel={cancel}
        pending={pending}
        staff={staff}
      />

      {error && (
        <p className="mt-4 text-xs text-red-700 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
