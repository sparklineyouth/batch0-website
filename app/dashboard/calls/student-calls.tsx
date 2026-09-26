"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  InviteList,
  splitInvitesByPhase,
} from "@/components/live/invite-card";
import { InterviewRequestCard } from "@/components/interview-request-card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { getActionError } from "@/lib/action-error";
import { cancelInvite, respondToInvite } from "@/app/calls/actions";
import type { CallInvite } from "@/lib/live";
import type { InterviewRequest } from "@/lib/interview-requests";
import {
  ScholarshipCallCard,
  type ScholarshipCallState,
} from "@/components/scholarship-call-card";

/**
 * The student's side: invites addressed to them.
 *
 * Split into "needs an answer" and everything else, because the only thing
 * this page is really for is the first group — an unanswered invite is a task,
 * and burying it in a reverse-chronological list of past calls is how it gets
 * missed.
 *
 * "Upcoming" and "Past" are split by `callPhase`, not by status: the row stays
 * 'accepted' until someone presses End call, and a call that happened last
 * week used to sit under Upcoming with a Join button and "Add to calendar"
 * forever. It moves to Past, marked Completed, once its window has closed.
 */
export function StudentCalls({
  invites,
  interviewRequest = null,
  showInterviewRequest = false,
  scholarshipCall = null,
}: {
  invites: CallInvite[];
  interviewRequest?: InterviewRequest | null;
  showInterviewRequest?: boolean;
  /** Set only when the student holds a learner's scholarship. */
  scholarshipCall?: ScholarshipCallState | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  // The split needs a clock. Taken once at first render (server and client
  // agree unless a call's window closes in the second between them) and
  // re-taken every minute, so a call that ends while the page is open moves
  // to Past without a reload.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const {
    pending: pendingInvites,
    upcoming,
    past,
  } = splitInvitesByPhase(invites, now);

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

  // "Can't make it": the invitee backing out of an accepted call before it
  // starts. The card offers it only then, and cancelInvite enforces the same
  // window and tells the host. Once the call has started, Leave inside the
  // room is how a student steps out. Confirmed first, because it cannot be
  // undone from this side — the host would have to book again.
  const [confirmWithdraw, setConfirmWithdraw] = useState<string | null>(null);
  function withdraw(id: string) {
    setError(undefined);
    start(async () => {
      try {
        await cancelInvite(id);
        setConfirmWithdraw(null);
        router.refresh();
      } catch (err: any) {
        setConfirmWithdraw(null);
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
        happen right here — nothing to install.
      </p>

      {error && (
        <p className="mt-4 text-xs text-red-700 dark:text-red-400">{error}</p>
      )}

      {scholarshipCall && (
        <div className="mt-8">
          <ScholarshipCallCard state={scholarshipCall} />
        </div>
      )}

      {showInterviewRequest && (
        <div className="mt-8">
          <InterviewRequestCard request={interviewRequest} />
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
          invites={upcoming}
          perspective="invitee"
          emptyMessage="No calls booked. Mentors and investors can invite you here."
          onCancel={setConfirmWithdraw}
          pending={pending}
        />
      </section>

      {past.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
            Past
          </h2>
          <InviteList
            invites={past}
            perspective="invitee"
            emptyMessage=""
            pending={pending}
          />
        </section>
      )}

      <ConfirmDialog
        open={confirmWithdraw !== null}
        title="Can’t make this call?"
        description={
          <p>
            The call is cancelled and whoever booked it is told you can&rsquo;t
            make it. They can invite you again for another time.
          </p>
        }
        confirmLabel="Cancel the call"
        cancelLabel="Keep it"
        destructive
        pending={pending}
        onConfirm={() => confirmWithdraw && withdraw(confirmWithdraw)}
        onCancel={() => !pending && setConfirmWithdraw(null)}
      />
    </div>
  );
}
