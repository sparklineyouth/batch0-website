"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CallSections } from "@/components/live/invite-card";
import {
  InterviewRequestCard,
  type ScholarshipCallState,
} from "@/components/interview-request-card";
import { getActionError } from "@/lib/action-error";
import { declineInvite } from "@/app/calls/actions";
import type { CallInvite } from "@/lib/live";
import type { InterviewRequest } from "@/lib/interview-requests";
import type { RequestCardState } from "@/lib/call-lifecycle";

/** The student's calls: the request card, what's coming up, and the past. */
export function StudentCalls({
  invites,
  now,
  request,
  requestState,
  requestIsScholarship,
  scholarship,
}: {
  invites: CallInvite[];
  /** The server's render time (ISO). */
  now: string;
  request: InterviewRequest | null;
  requestState: RequestCardState;
  requestIsScholarship: boolean;
  scholarship: ScholarshipCallState | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function decline(id: string) {
    if (!window.confirm("Decline this call? They're told you can't make it.")) return;
    setError(undefined);
    start(async () => {
      try {
        const result = await declineInvite(id);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">1:1 calls</h1>
      <p className="mt-1 text-sm text-ink-faint">
        Private video calls with mentors, investors and the batch0 team. Recorded.
      </p>

      {requestState !== "hidden" && (
        <div className="mt-8">
          <InterviewRequestCard
            request={request}
            state={requestState}
            scholarship={scholarship}
            requestIsScholarship={requestIsScholarship}
          />
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <section className="mt-8">
        <CallSections
          invites={invites}
          perspective="invitee"
          now={now}
          showRecording
          emptyMessage="No calls booked."
          onDecline={decline}
          pending={pending}
        />
      </section>
    </div>
  );
}
