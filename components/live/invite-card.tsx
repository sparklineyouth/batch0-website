"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, ButtonLink } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { LiveDot } from "@/components/live/call-stage";
import { callPhase, relativeTime, type CallInvite, type CallPhase } from "@/lib/live";
import { CalendarPlus, Clock, User } from "lucide-react";

/**
 * Whose eyes the card is drawn for.
 *
 *   host      The person who sent the invite (the call's owner).
 *   invitee   The student it was sent to.
 *   observer  Staff looking at a call they are NOT part of — the safeguarding
 *             list on /admin/calls. Names both people (that is the fact the
 *             view exists to answer) and offers no Join and no calendar link:
 *             a non-party can never enter a 1:1, and the room would refuse
 *             them anyway (the page 404s, joinRoom says no-access). A Cancel
 *             appears only if the page passes `onCancel`, which it does for a
 *             superAdmin alone.
 */
export type InvitePerspective = "host" | "invitee" | "observer";

/**
 * One 1:1 invite.
 *
 * The same card serves every side of the invite — a host reviewing what they
 * sent, a student deciding whether to accept, an admin reading the
 * safeguarding list — because the information is identical and only the
 * actions differ. `perspective` picks the verbs.
 *
 * What the card offers is driven by `callPhase` (lib/live.ts), not by the raw
 * status. The database keeps an accepted call at 'accepted' until someone
 * presses End call, so reading the status alone left a call that happened last
 * week under "Upcoming" with Join, Add to calendar and Cancel — and Cancel on a
 * call that already happened refunded a scholarship credit it had spent. A
 * call whose window has closed is 'completed' here whatever the row says.
 *
 * Every action renders only when its handler is passed. A Cancel button with
 * no `onCancel` used to render on the admin list and do nothing when clicked.
 */
export function InviteCard({
  invite,
  perspective,
  onAccept,
  onDecline,
  onCancel,
  pending = false,
}: {
  invite: CallInvite;
  perspective: InvitePerspective;
  onAccept?: (id: string) => void;
  onDecline?: (id: string) => void;
  onCancel?: (id: string) => void;
  pending?: boolean;
}) {
  // The join window depends on the current time, which the server doesn't
  // share with the client. Rendering it only after mount keeps SSR and the
  // first client paint identical — the same trick `LocalTime` uses.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Null until mounted, for an accepted call only — every other status is
  // clock-free, so it is right on the first paint too.
  const phase: CallPhase | null =
    invite.status === "accepted" && !now ? null : callPhase(invite, now ?? undefined);
  const started = !!now && now.getTime() >= new Date(invite.startsAt).getTime();
  const joinable = phase === "joinable" && perspective !== "observer";
  // The live dot means "the call is on now", which is true for an observer
  // too; they just get no button to act on it.
  const live = phase === "joinable" && started;
  // An accepted call whose window has closed reads "completed", matching the
  // Past section it has been moved to.
  const badge = phase === "completed" ? "completed" : invite.status;

  // Cancelling is for a call that has not happened. `cancelInvite` enforces
  // the same rule server-side (and refuses a finished call outright); this
  // only stops the button being offered.
  const cancellable =
    phase === "invited" || phase === "upcoming" || phase === "joinable";
  // The invitee's "Can't make it" is a cancel before the start, and only for
  // a call they already accepted — an unanswered invite has Decline. Once it
  // has started, Leave inside the room is how they step out.
  const inviteeCanWithdraw =
    perspective === "invitee" &&
    invite.status === "accepted" &&
    cancellable &&
    !!now &&
    !started;
  const showCancel =
    !!onCancel &&
    (perspective === "invitee" ? inviteeCanWithdraw : cancellable);

  return (
    <div className="rounded-2xl border border-line bg-wash p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">
              {invite.topic || "1:1 call"}
            </h3>
            {live ? <LiveDot /> : <StatusBadge status={badge} />}
          </div>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
            <span className="inline-flex items-center gap-1.5">
              <User className="h-3.5 w-3.5" />
              {perspective === "observer" ? (
                <>
                  {invite.hostName}
                  <span className="font-mono uppercase tracking-wider text-ink-faint/80">
                    ({invite.hostRole})
                  </span>
                  with {invite.inviteeName}
                </>
              ) : perspective === "host" ? (
                <>With {invite.inviteeName}</>
              ) : (
                <>
                  From {invite.hostName}
                  <span className="font-mono uppercase tracking-wider text-ink-faint/80">
                    {invite.hostRole}
                  </span>
                </>
              )}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              <LocalTime value={invite.startsAt} mode="datetime-short" />
              <span aria-hidden>·</span>
              {invite.durationMinutes} min
            </span>
            {now && (phase === "invited" || phase === "upcoming") && !started && (
              <span suppressHydrationWarning>
                {relativeTime(invite.startsAt, now)}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {invite.status === "invited" &&
            perspective === "invitee" &&
            onAccept &&
            onDecline && (
              <>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => onAccept(invite.id)}
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => onDecline(invite.id)}
                >
                  Decline
                </Button>
              </>
            )}

          {joinable && (
            <ButtonLink size="sm" href={`/dashboard/calls/${invite.id}/live`}>
              {live ? "Join now" : "Join"}
            </ButtonLink>
          )}

          {/* Before the window only. Inside it there is a Join button, and
              after it the call is over — a calendar entry for a call that
              already happened is noise. Never for an observer: it is not
              their meeting. */}
          {phase === "upcoming" && perspective !== "observer" && (
            <Link
              href={`/api/calls/${invite.id}/ics`}
              className="inline-flex items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
            >
              <CalendarPlus className="h-3.5 w-3.5" />
              Add to calendar
            </Link>
          )}

          {showCancel && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => onCancel!(invite.id)}
            >
              {perspective === "invitee" ? "Can’t make it" : "Cancel"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A list of invites with an empty state, used on every calls page. */
export function InviteList({
  invites,
  perspective,
  emptyMessage,
  onAccept,
  onDecline,
  onCancel,
  pending,
}: {
  invites: CallInvite[];
  perspective: InvitePerspective;
  emptyMessage: string;
  onAccept?: (id: string) => void;
  onDecline?: (id: string) => void;
  onCancel?: (id: string) => void;
  pending?: boolean;
}) {
  if (invites.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-center">
        <p className="text-sm text-ink-faint">{emptyMessage}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {invites.map((i) => (
        <InviteCard
          key={i.id}
          invite={i}
          perspective={perspective}
          onAccept={onAccept}
          onDecline={onDecline}
          onCancel={onCancel}
          pending={pending}
        />
      ))}
    </div>
  );
}

/**
 * Split invites into what is still ahead and what is over, by `callPhase`.
 *
 * Shared by every calls list so "is this call finished" has one answer: an
 * accepted call past its window is Past, not Upcoming, on the student's page,
 * the host panels and the admin list alike. Pure in `now`, which callers take
 * from a clock they already hold.
 */
export function splitInvitesByPhase(
  invites: CallInvite[],
  now: Date,
): { pending: CallInvite[]; upcoming: CallInvite[]; past: CallInvite[] } {
  const pending: CallInvite[] = [];
  const upcoming: CallInvite[] = [];
  const past: CallInvite[] = [];
  for (const i of invites) {
    const phase = callPhase(i, now);
    if (phase === "invited") pending.push(i);
    else if (phase === "upcoming" || phase === "joinable") upcoming.push(i);
    else past.push(i);
  }
  return { pending, upcoming, past };
}
