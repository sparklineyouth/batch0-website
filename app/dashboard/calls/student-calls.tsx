"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { InviteList, PastCalls, useNow } from "@/components/live/invite-card";
import { InterviewRequestCard } from "@/components/interview-request-card";
import { getActionError } from "@/lib/action-error";
import { respondToInvite } from "@/app/calls/actions";
import type { CallInvite } from "@/lib/live";
import type { InterviewRequest } from "@/lib/interview-requests";
import {
  callPhase,
  splitCalls,
  type InterviewCardState,
} from "@/lib/call-lifecycle";
import {
  ScholarshipCallCard,
  type ScholarshipCallState,
} from "@/components/scholarship-call-card";

/**
 * The student's side: invites addressed to them.
 *
 * Split into "needs an answer", what's coming up, and the past, because the
 * only thing this page is really for is the first group — an unanswered invite
 * is a task, and burying it in a list of past calls is how it gets missed.
 *
 * The split is by PHASE (lib/call-lifecycle.ts), not status. It used to be
 * status alone, so an accepted call stayed under "Upcoming" for ever after it
 * happened — the one call in production that week was a week old — and an
 * invite whose time had passed still sat under "Needs an answer" with an
 * Accept button that led to a room that would never open.
 */
export function StudentCalls({
  invites,
  now: serverNow,
  recordings,
  interviewRequest = null,
  interviewState = "hidden",
  scholarshipCall = null,
}: {
  invites: CallInvite[];
  /** The server's render time (ISO). See `useNow`. */
  now: string;
  /** inviteId → recorded parts, for this student's own past calls. */
  recordings?: Record<string, number>;
  interviewRequest?: InterviewRequest | null;
  /** Decided on the server from the request AND its call — see the page. */
  interviewState?: InterviewCardState;
  /** Set only when the student holds a learner's scholarship. */
  scholarshipCall?: ScholarshipCallState | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  const { now: clock } = useNow(serverNow);
  const now = clock ?? new Date(serverNow);
  const { upcoming, past } = splitCalls(invites, now);
  const pendingInvites = upcoming.filter(
    (i) => callPhase(i, now) === "needs_answer",
  );
  const booked = upcoming.filter((i) => callPhase(i, now) !== "needs_answer");

  function respond(id: string, response: "accepted" | "declined") {
    setError(undefined);
    start(async () => {
      try {
        await respondToInvite(id, response);
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        1:1 calls
      </h1>
      <p className="mt-1 text-sm text-ink-faint">
        Private video calls with mentors, investors, and the batch0 team. They
        happen right here — nothing to install. Calls are recorded so you can
        watch them back.
      </p>

      {error && (
        <p className="mt-4 text-xs text-red-700 dark:text-red-400">{error}</p>
      )}

      {scholarshipCall && (
        <div className="mt-8">
          <ScholarshipCallCard state={scholarshipCall} />
        </div>
      )}

      {interviewState !== "hidden" && (
        <div className="mt-8">
          <InterviewRequestCard
            request={interviewRequest}
            state={interviewState}
          />
        </div>
      )}

      {pendingInvites.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
            Needs an answer
          </h2>
          <InviteList
            invites={pendingInvites}
            perspective="invitee"
            now={clock}
            emptyMessage=""
            onAccept={(id) => respond(id, "accepted")}
            onDecline={(id) => respond(id, "declined")}
            pending={pending}
          />
        </section>
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Upcoming
        </h2>
        <InviteList
          invites={booked}
          perspective="invitee"
          now={clock}
          emptyMessage="No calls booked. Mentors and investors can invite you here."
          pending={pending}
        />
      </section>

      <PastCalls count={past.length}>
        <InviteList
          invites={past}
          perspective="invitee"
          now={clock}
          recordings={recordings}
          emptyMessage=""
          pending={pending}
        />
      </PastCalls>
    </div>
  );
}
