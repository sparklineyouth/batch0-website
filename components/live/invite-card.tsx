"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, ButtonLink } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { LiveDot } from "@/components/live/call-stage";
import {
  AddPeopleForm,
  JoinCallConfirm,
  addableStaff,
} from "@/components/live/add-to-call";
import type { InviteeOption } from "@/components/live/invite-form";
import { joinNames, relativeTime, staffNames, type CallInvite } from "@/lib/live";
import {
  callBadge,
  callPhase,
  canAddCallCohosts,
  canCancelCall,
  mayHaveCallRecording,
  splitCalls,
  type CallPhase,
} from "@/lib/call-lifecycle";
import { CallRecordings } from "@/components/live/recording-player";
import {
  CalendarPlus,
  ChevronRight,
  Clock,
  User,
  UserPlus,
  Users,
} from "lucide-react";

/**
 * Who is looking at a card, which decides the verbs.
 *
 *   host      on the staff side — sent the invite, or was added to it as a
 *             co-host (migration 0092). May cancel, may add more of the team
 *             while the call can still happen, and joins the call
 *   invitee   received it — may accept or decline, and joins the call
 *   observer  an admin reading the safeguarding list of everyone else's calls.
 *             Reads only, unless they hold calls.join_any, and then the one
 *             verb is putting THEMSELVES on the call: Join call once the room
 *             is open, Add me before that. The live page 404s anyone who is
 *             not on the call, so a plain Join here used to be a door that did
 *             not open. This one opens by adding you as a co-host, visibly:
 *             the student is told, and everyone on the call sees you. Never
 *             Cancel, which stays with the people on the call.
 */
export type InvitePerspective = "host" | "invitee" | "observer";

/**
 * The clock the calls pages run on.
 *
 * Seeded from the SERVER's render time, which is the fix for the flash: the
 * card used to start with no clock at all, and with no clock every accepted
 * call rendered "Add to calendar" — including last week's — until the first
 * effect ran and took it away again. Seeding from the server means the server
 * render, the first client paint and hydration all compute the same phase
 * from the same instant, and the ticking client clock takes over after mount
 * so a card left open flips to "Join" when the window opens.
 *
 * `mounted` gates the one thing that is still client-only: the relative
 * "in 3 hours" label, which reads the viewer's locale.
 */
export function useNow(initialIso?: string | null): {
  now: Date | null;
  mounted: boolean;
} {
  const [now, setNow] = useState<Date | null>(() =>
    initialIso ? new Date(initialIso) : null,
  );
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return { now, mounted };
}

/** `mounted` always; a ticking clock only when `tick` (see InviteCard). */
function useOwnClock(tick: boolean): { now: Date | null; mounted: boolean } {
  const [now, setNow] = useState<Date | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    if (!tick) return;
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, [tick]);
  return { now, mounted };
}

/**
 * One 1:1 invite.
 *
 * The same card serves every side of the invite, because the information is
 * identical and only the actions differ. What those actions are is decided by
 * the call's PHASE (lib/call-lifecycle.ts) — status and clock together — not
 * by its status alone: an accepted call whose window has closed is over, and
 * offering "Add to calendar", "Cancel" or "Accept" on it was offering to act
 * on the past.
 */
export function InviteCard({
  invite,
  perspective,
  now: nowProp,
  showRecordings = false,
  onAccept,
  onDecline,
  onCancel,
  pending = false,
  staff,
  viewerId,
  canJoinAny = false,
}: {
  invite: CallInvite;
  perspective: InvitePerspective;
  /**
   * The list's clock. Omitted, the card keeps its own, starting from nothing
   * — and with no clock it shows no time-dependent action at all rather than
   * guessing one.
   */
  now?: Date | null;
  /**
   * Observer cards: show the call's recordings (admins only). The people on
   * the call always see them; the API decides either way.
   */
  showRecordings?: boolean;
  onAccept?: (id: string) => void;
  onDecline?: (id: string) => void;
  onCancel?: (id: string) => void;
  pending?: boolean;
  /**
   * Host cards: the team, for Add people. The page has already left the
   * viewer out; the card leaves out everyone else on this call (addableStaff).
   * Omitted, the card offers no Add people.
   */
  staff?: InviteeOption[];
  /** Observer cards: the viewer, whom Join call / Add me puts on the call. */
  viewerId?: string;
  /**
   * Observer cards: the viewer holds calls.join_any. Without it an observer
   * card stays exactly as read-only as it always was.
   */
  canJoinAny?: boolean;
}) {
  // A card inside a list runs on the list's clock; only a card rendered on
  // its own ticks one of its own.
  const own = useOwnClock(nowProp === undefined);
  const now = nowProp !== undefined ? nowProp : own.now;
  const mounted = own.mounted;
  // Add people, or an observer's Join call / Add me, is open below the card.
  const [adding, setAdding] = useState(false);

  const phase: CallPhase | null = now ? callPhase(invite, now) : null;
  const live = phase === "live";
  const roomOpen = phase === "joinable" || phase === "live";
  const participant = perspective !== "observer";
  const joinable = participant && roomOpen;
  // Every participant's Join, and an observer's once they are on the call.
  const roomHref = `/dashboard/calls/${invite.id}/live`;

  // Putting more people on the call (components/live/add-to-call.tsx), only
  // while it can still happen (canAddCallCohosts) and, like every verb here
  // that depends on the time, never before there is a clock to say so. The
  // staff side adds the team; an observer holding calls.join_any adds only
  // themselves. The server decides both again; this decides what to offer.
  const addable = !!now && canAddCallCohosts(invite, now);
  const offer =
    addable && perspective === "host" && staff ? addableStaff(invite, staff) : [];
  const canAddPeople = offer.length > 0;
  const canJoinCall =
    addable && perspective === "observer" && canJoinAny && !!viewerId;
  // `adding` only counts while its panel can show: a call whose time runs out
  // with the panel open closes it, and gives the card its other verbs back.
  const addingPeople = adding && canAddPeople;
  const joiningCall = adding && canJoinCall;
  // The student meets the whole team, host first. The staff side meets the
  // student — and, when there are co-hosts, is shown the team too, because a
  // co-host reading their own list needs to see who sent it and who else is
  // coming.
  const team = staffNames(invite);
  const other =
    perspective === "invitee"
      ? joinNames(team)
      : perspective === "host"
        ? invite.inviteeName
        : null;

  return (
    <div className="rounded-2xl border border-line bg-wash p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">
              {invite.topic || "1:1 call"}
            </h3>
            {live ? (
              <LiveDot />
            ) : (
              <StatusBadge status={phase ? callBadge(phase) : invite.status} />
            )}
          </div>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
            {/* Wraps between people on the observer card: one group per
                staff member plus the student, in a monospace face, runs past
                a phone's width at three staff — and without wrapping it ran
                the student's name, the one this list exists to show, out of
                view. Each person stays whole; the line breaks between them. */}
            <span
              className={`inline-flex min-w-0 items-center gap-x-1.5 ${
                other ? "" : "flex-wrap gap-y-1"
              }`}
            >
              <User className="h-3.5 w-3.5 shrink-0" />
              {other ? (
                <>
                  {perspective === "host" ? "With" : "From"} {other}
                  {perspective === "invitee" && invite.cohosts.length === 0 && (
                    <span className="font-mono uppercase tracking-wider text-ink-faint/80">
                      {invite.hostRole}
                    </span>
                  )}
                </>
              ) : (
                // The observer sees every name and role — whose call it is is
                // the whole question the safeguarding list exists to answer.
                <>
                  {[
                    { id: "host", name: invite.hostName, role: invite.hostRole },
                    ...invite.cohosts,
                  ].map((p, i) => (
                    <span key={p.id} className="inline-flex items-center gap-1.5">
                      {i > 0 && <span aria-hidden>+</span>}
                      {p.name}
                      <span className="font-mono uppercase tracking-wider text-ink-faint/80">
                        {p.role}
                      </span>
                    </span>
                  ))}
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden>→</span>
                    {invite.inviteeName}
                  </span>
                </>
              )}
            </span>
            {perspective === "host" && invite.cohosts.length > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5" />
                {joinNames(team)}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              <LocalTime value={invite.startsAt} mode="datetime-short" />
              <span aria-hidden>·</span>
              {invite.durationMinutes} min
            </span>
            {mounted && now && (phase === "upcoming" || phase === "needs_answer") && (
              <span suppressHydrationWarning>
                {relativeTime(invite.startsAt, now)}
              </span>
            )}
          </div>

          {phase === "expired" && perspective !== "observer" && (
            <p className="mt-2 text-xs text-ink-faint">
              {perspective === "invitee"
                ? "This invite's time passed before it was answered."
                : "They didn't answer before the time passed. Withdraw it to close it out (a scholarship call's credit goes back to them), and send a new invite if you'd still like to talk."}
            </p>
          )}

          {(participant || showRecordings) &&
            now &&
            (phase === "ended" || phase === "completed" || phase === "cancelled") &&
            mayHaveCallRecording(invite, now) && <CallRecordings inviteId={invite.id} />}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {phase === "needs_answer" && perspective === "invitee" && (
            <>
              <Button
                size="sm"
                disabled={pending}
                onClick={() => onAccept?.(invite.id)}
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => onDecline?.(invite.id)}
              >
                Decline
              </Button>
            </>
          )}

          {joinable && (
            <ButtonLink size="sm" href={roomHref}>
              {live ? "Join now" : "Join"}
            </ButtonLink>
          )}

          {participant && phase === "upcoming" && (
            <Link
              href={`/api/calls/${invite.id}/ics`}
              className="inline-flex items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
            >
              <CalendarPlus className="h-3.5 w-3.5" />
              Add to calendar
            </Link>
          )}

          {canAddPeople && !addingPeople && (
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              <UserPlus className="h-4 w-4" />
              Add people
            </Button>
          )}

          {/* The observer's door: the same verb as the participants' Join
              once the room is open, a quiet Add me before it. Either one
              opens a confirm below rather than acting on the press. */}
          {canJoinCall &&
            !joiningCall &&
            (roomOpen ? (
              <Button size="sm" onClick={() => setAdding(true)}>
                Join call
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
                <UserPlus className="h-4 w-4" />
                Add me
              </Button>
            ))}

          {/* Not while Add people is open: that form has its own Cancel, and
              two Cancels on one card, one of which calls the call off on the
              spot, is a trap. */}
          {perspective === "host" &&
            onCancel &&
            now &&
            !addingPeople &&
            canCancelCall(invite, now) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => onCancel(invite.id)}
              >
                {/* An expired invite was never agreed to, so nothing is being
                    called off — it is being withdrawn (see canCancelCall). */}
                {phase === "expired" ? "Withdraw" : "Cancel"}
              </Button>
            )}
        </div>
      </div>

      {addingPeople && (
        <AddPeopleForm
          inviteId={invite.id}
          studentName={invite.inviteeName}
          offer={offer}
          already={invite.cohosts.length}
          onClose={() => setAdding(false)}
        />
      )}

      {joiningCall && viewerId && (
        <JoinCallConfirm
          inviteId={invite.id}
          viewerId={viewerId}
          studentName={invite.inviteeName}
          enterHref={roomOpen ? roomHref : null}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/** A list of invites with an empty state, used on every calls page. */
export function InviteList({
  invites,
  perspective,
  emptyMessage,
  now,
  showRecordings,
  onAccept,
  onDecline,
  onCancel,
  pending,
  staff,
  viewerId,
  canJoinAny,
}: {
  invites: CallInvite[];
  perspective: InvitePerspective;
  emptyMessage: string;
  now?: Date | null;
  /** Observer lists: show recordings (admins only). See InviteCard. */
  showRecordings?: boolean;
  onAccept?: (id: string) => void;
  onDecline?: (id: string) => void;
  onCancel?: (id: string) => void;
  pending?: boolean;
  /** Host lists: the team, for Add people. See InviteCard. */
  staff?: InviteeOption[];
  /** Observer lists: the viewer, and whether they hold calls.join_any. */
  viewerId?: string;
  canJoinAny?: boolean;
}) {
  if (invites.length === 0) {
    if (!emptyMessage) return null;
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
          now={now}
          showRecordings={showRecordings}
          onAccept={onAccept}
          onDecline={onDecline}
          onCancel={onCancel}
          pending={pending}
          staff={staff}
          viewerId={viewerId}
          canJoinAny={canJoinAny}
        />
      ))}
    </div>
  );
}

/**
 * Past calls, folded away.
 *
 * Secondary on purpose — the page is for what is coming up — but one click
 * from the top, because this is where a recording is found afterwards.
 */
export function PastCalls({
  count,
  children,
  className = "mt-10",
}: {
  count: number;
  children: React.ReactNode;
  className?: string;
}) {
  if (count === 0) return null;
  return (
    <details className={`group ${className}`}>
      <summary className="mb-3 flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
        Past
        <span className="font-mono font-normal normal-case tracking-normal">
          · {count}
        </span>
      </summary>
      {children}
    </details>
  );
}

/**
 * Upcoming, then Past — the shape of every host-side list.
 *
 * Split by phase on the shared clock, so a call slides from one section to
 * the other while the page is open rather than on the next reload, and the
 * split the server rendered is the split the first paint shows.
 */
export function CallSections({
  invites,
  perspective,
  now: initialNow,
  showRecordings,
  emptyMessage,
  onCancel,
  pending,
  staff,
  viewerId,
  canJoinAny,
}: {
  invites: CallInvite[];
  perspective: InvitePerspective;
  /** The server's render time, as ISO. See `useNow`. */
  now: string;
  /** Observer lists: show recordings (admins only). See InviteCard. */
  showRecordings?: boolean;
  emptyMessage: string;
  onCancel?: (id: string) => void;
  pending?: boolean;
  /** Host lists: the team, for Add people. See InviteCard. */
  staff?: InviteeOption[];
  /** Observer lists: the viewer, and whether they hold calls.join_any. */
  viewerId?: string;
  canJoinAny?: boolean;
}) {
  const { now } = useNow(initialNow);
  const { upcoming, past } = splitCalls(invites, now ?? new Date(initialNow));
  return (
    <>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
        Upcoming
      </h3>
      <InviteList
        invites={upcoming}
        perspective={perspective}
        now={now}
        emptyMessage={
          past.length > 0 ? "Nothing coming up. Past calls are below." : emptyMessage
        }
        onCancel={onCancel}
        pending={pending}
        staff={staff}
        viewerId={viewerId}
        canJoinAny={canJoinAny}
      />
      <PastCalls count={past.length} className="mt-8">
        {/* Cancel is wired here too, for the one past card that offers it:
            an invite that expired unanswered, which the host can withdraw
            (canCancelCall decides; every other past card shows no button).
            Adding people is not: no past phase is one canAddCallCohosts
            allows, so a past card never offers it. */}
        <InviteList
          invites={past}
          perspective={perspective}
          now={now}
          showRecordings={showRecordings}
          emptyMessage=""
          onCancel={onCancel}
          pending={pending}
        />
      </PastCalls>
    </>
  );
}
