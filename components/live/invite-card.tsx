"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, ButtonLink } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { LiveDot } from "@/components/live/call-stage";
import { AddPeopleForm, JoinCallConfirm, addableStaff } from "@/components/live/add-to-call";
import { EditCallForm, type InviteeOption } from "@/components/live/invite-form";
import { CallRecordings } from "@/components/live/recording-player";
import { callMayHaveRecording } from "@/lib/call-recording";
import { joinNames, relativeTime, staffNames, type CallInvite } from "@/lib/live";
import {
  callBadge,
  callListPhase,
  callPhase,
  canAddCallCohosts,
  canCancelCall,
  canDeclineCall,
  canEditCall,
  isPastPhase,
  isRoomOpenPhase,
  isRunningOver,
  splitCalls,
  type CallPhase,
} from "@/lib/call-lifecycle";
import { CalendarPlus, ChevronRight, Clock, Pencil, User, UserPlus, Users } from "lucide-react";

/**
 * Who is looking at a card, which decides the verbs.
 *
 *   host      on the staff side (host or co-host): join, edit, add people, cancel
 *   invitee   the student: join, add to calendar, decline
 *   observer  an admin reading everyone else's calls (safeguarding). Read-only,
 *             except that a calls.join_any holder may add THEMSELVES (visibly).
 */
export type InvitePerspective = "host" | "invitee" | "observer";

/**
 * The clock the calls pages run on: seeded from the server's render time so
 * the first paint matches the server, then ticking so a card flips to Join
 * when its room opens.
 */
export function useNow(initialIso?: string | null): { now: Date | null; mounted: boolean } {
  const [now, setNow] = useState<Date | null>(() => (initialIso ? new Date(initialIso) : null));
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return { now, mounted };
}

/** One 1:1. What it offers is decided by its phase (status and clock), per side. */
export function InviteCard({
  invite,
  perspective,
  now,
  mounted = true,
  showRecording = false,
  onDecline,
  onCancel,
  pending = false,
  staff,
  viewerId,
  canJoinAny = false,
}: {
  invite: CallInvite;
  perspective: InvitePerspective;
  /** The list's clock. Null shows no time-dependent action rather than guessing. */
  now: Date | null;
  /** Client-mounted: gates the locale-dependent "in 3 hours" label. */
  mounted?: boolean;
  /** Whether this viewer may watch the call back (the page decides). */
  showRecording?: boolean;
  onDecline?: (id: string) => void;
  onCancel?: (id: string) => void;
  pending?: boolean;
  /** Host cards: the team, for Add people (the page has left the viewer out). */
  staff?: InviteeOption[];
  /** Observer cards: the viewer, whom Join call / Add me puts on the call. */
  viewerId?: string;
  /** Observer cards: the viewer holds calls.join_any. */
  canJoinAny?: boolean;
}) {
  // Which panel is open below the card.
  const [panel, setPanel] = useState<"add" | "edit" | null>(null);

  const side = perspective === "invitee" ? "student" : "staff";
  // What the list says (a call nobody ended is over 30 minutes after its
  // end), and whether the room's door is still open (to the hard close).
  const phase: CallPhase | null = now ? callListPhase(invite, now, side) : null;
  const joinable = !!phase && isRoomOpenPhase(phase);
  const rejoinable =
    phase === "ended" && !!now && isRoomOpenPhase(callPhase(invite, now, side));
  const participant = perspective !== "observer";
  const roomHref = `/dashboard/calls/${invite.id}/live`;
  const overrun = !!now && isRunningOver(invite, now);

  const host = perspective === "host";
  const addable = !!now && canAddCallCohosts(invite, now);
  const offer = addable && host && staff ? addableStaff(invite, staff) : [];
  const canJoinCall = addable && perspective === "observer" && canJoinAny && !!viewerId;
  const editable = host && !!now && canEditCall(invite, now);
  // A panel only counts while it can show; a call that ends closes it.
  const adding = panel === "add" && (offer.length > 0 || canJoinCall);
  const editing = panel === "edit" && editable;

  const team = staffNames(invite);
  const other = perspective === "invitee" ? joinNames(team) : host ? invite.inviteeName : null;

  return (
    <div className="rounded-2xl border border-line bg-wash p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">{invite.topic || "1:1 call"}</h3>
            {phase === "live" && !overrun ? (
              <LiveDot />
            ) : (
              <StatusBadge
                status={overrun ? "running over" : phase ? callBadge(phase) : invite.status}
              />
            )}
          </div>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
            <span
              className={`inline-flex min-w-0 items-center gap-x-1.5 ${other ? "" : "flex-wrap gap-y-1"}`}
            >
              <User className="h-3.5 w-3.5 shrink-0" />
              {other ? (
                <>
                  {host ? "With" : "From"} {other}
                  {perspective === "invitee" && invite.cohosts.length === 0 && (
                    <span className="font-mono uppercase tracking-wider text-ink-faint/80">
                      {invite.hostRole}
                    </span>
                  )}
                </>
              ) : (
                // The observer sees every name and role: whose call it is is
                // the question the safeguarding list answers.
                <>
                  {[{ id: "host", name: invite.hostName, role: invite.hostRole }, ...invite.cohosts].map(
                    (p, i) => (
                      <span key={p.id} className="inline-flex items-center gap-1.5">
                        {i > 0 && <span aria-hidden>+</span>}
                        {p.name}
                        <span className="font-mono uppercase tracking-wider text-ink-faint/80">
                          {p.role}
                        </span>
                      </span>
                    ),
                  )}
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden>→</span>
                    {invite.inviteeName}
                  </span>
                </>
              )}
            </span>
            {host && invite.cohosts.length > 0 && (
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
              <span suppressHydrationWarning>{relativeTime(invite.startsAt, now)}</span>
            )}
          </div>

          {/* Any past call whose room opened, an unanswered invite included. */}
          {showRecording && now && phase && isPastPhase(phase) && callMayHaveRecording(invite, now) && (
            <CallRecordings inviteId={invite.id} />
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {participant && joinable && (
            <ButtonLink size="sm" href={roomHref}>
              {phase === "live" ? "Join now" : "Join"}
            </ButtonLink>
          )}

          {/* Over by the list, but the room is still open for anyone who
              dropped out of a call that ran long. */}
          {participant && rejoinable && (
            <Link href={roomHref} className="text-xs text-ink-faint underline underline-offset-2 hover:text-ink">
              Rejoin
            </Link>
          )}

          {participant && (phase === "needs_answer" || phase === "upcoming") && (
            <Link
              href={`/api/calls/${invite.id}/ics`}
              className="inline-flex items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
            >
              <CalendarPlus className="h-3.5 w-3.5" />
              Add to calendar
            </Link>
          )}

          {editable && !panel && (
            <Button size="sm" variant="ghost" onClick={() => setPanel("edit")}>
              <Pencil className="h-4 w-4" />
              Edit
            </Button>
          )}

          {offer.length > 0 && !panel && (
            <Button size="sm" variant="ghost" onClick={() => setPanel("add")}>
              <UserPlus className="h-4 w-4" />
              Add people
            </Button>
          )}

          {canJoinCall &&
            !panel &&
            (joinable ? (
              <Button size="sm" onClick={() => setPanel("add")}>
                Join call
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setPanel("add")}>
                <UserPlus className="h-4 w-4" />
                Add me
              </Button>
            ))}

          {host && onCancel && now && !panel && canCancelCall(invite, now) && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => onCancel(invite.id)}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {perspective === "invitee" && onDecline && now && canDeclineCall(invite, now) && (
        <button
          type="button"
          disabled={pending}
          onClick={() => onDecline(invite.id)}
          className="mt-3 text-xs text-ink-faint underline underline-offset-2 hover:text-ink disabled:opacity-50"
        >
          Can&rsquo;t make it? Decline
        </button>
      )}

      {editing && <EditCallForm invite={invite} onClose={() => setPanel(null)} />}

      {adding && host && (
        <AddPeopleForm
          inviteId={invite.id}
          studentName={invite.inviteeName}
          offer={offer}
          already={invite.cohosts.length}
          onClose={() => setPanel(null)}
        />
      )}

      {adding && canJoinCall && viewerId && (
        <JoinCallConfirm
          inviteId={invite.id}
          viewerId={viewerId}
          studentName={invite.inviteeName}
          enterHref={joinable ? roomHref : null}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}

type ListProps = {
  invites: CallInvite[];
  perspective: InvitePerspective;
  now: Date | null;
  mounted?: boolean;
  showRecording?: boolean;
  onDecline?: (id: string) => void;
  onCancel?: (id: string) => void;
  pending?: boolean;
  staff?: InviteeOption[];
  viewerId?: string;
  canJoinAny?: boolean;
};

/** A list of calls with an empty state. */
export function InviteList({
  emptyMessage,
  invites,
  ...props
}: ListProps & { emptyMessage: string }) {
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
        <InviteCard key={i.id} {...props} invite={i} />
      ))}
    </div>
  );
}

/** A folded section: Past calls, or everyone else's on /admin/calls. */
export function Fold({
  label,
  count,
  children,
  className = "mt-8",
}: {
  label: string;
  count: number;
  children: React.ReactNode;
  className?: string;
}) {
  if (count === 0) return null;
  return (
    <details className={`group ${className}`}>
      <summary className="mb-3 flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
        {label}
        <span className="font-mono font-normal normal-case tracking-normal">· {count}</span>
      </summary>
      {children}
    </details>
  );
}

/**
 * Upcoming, then Past (folded) — every calls list. Split on the shared clock,
 * so a call moves sections while the page is open.
 */
export function CallSections({
  invites,
  now: serverNow,
  emptyMessage,
  ...props
}: Omit<ListProps, "now" | "mounted"> & {
  /** The server's render time, as ISO. See `useNow`. */
  now: string;
  emptyMessage: string;
}) {
  const { now, mounted } = useNow(serverNow);
  const { upcoming, past } = splitCalls(invites, now ?? new Date(serverNow));
  return (
    <>
      <InviteList
        {...props}
        invites={upcoming}
        now={now}
        mounted={mounted}
        emptyMessage={past.length > 0 ? "Nothing coming up." : emptyMessage}
      />
      <Fold label="Past" count={past.length}>
        <InviteList {...props} invites={past} now={now} mounted={mounted} emptyMessage="" />
      </Fold>
    </>
  );
}
