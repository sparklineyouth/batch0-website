"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, ButtonLink } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { LiveDot } from "@/components/live/call-stage";
import { relativeTime, type CallInvite } from "@/lib/live";
import {
  callBadge,
  callPhase,
  canCancelCall,
  splitCalls,
  type CallPhase,
} from "@/lib/call-lifecycle";
import { CalendarPlus, ChevronRight, CircleDot, Clock, User } from "lucide-react";

/**
 * Who is looking at a card, which decides the verbs.
 *
 *   host      sent the invite — may cancel, and joins the call
 *   invitee   received it — may accept or decline, and joins the call
 *   observer  an admin reading the safeguarding list of everyone else's calls.
 *             Reads only: the live page 404s for anyone not on the call, so a
 *             Join button here was a door that did not open, and Cancel was a
 *             button wired to nothing.
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
  recordingParts = 0,
  onAccept,
  onDecline,
  onCancel,
  pending = false,
}: {
  invite: CallInvite;
  perspective: InvitePerspective;
  /**
   * The list's clock. Omitted, the card keeps its own, starting from nothing
   * — and with no clock it shows no time-dependent action at all rather than
   * guessing one.
   */
  now?: Date | null;
  /** Recorded segments, for a past call. Zero hides the row. */
  recordingParts?: number;
  onAccept?: (id: string) => void;
  onDecline?: (id: string) => void;
  onCancel?: (id: string) => void;
  pending?: boolean;
}) {
  // A card inside a list runs on the list's clock; only a card rendered on
  // its own ticks one of its own.
  const own = useOwnClock(nowProp === undefined);
  const now = nowProp !== undefined ? nowProp : own.now;
  const mounted = own.mounted;

  const phase: CallPhase | null = now ? callPhase(invite, now) : null;
  const live = phase === "live";
  const participant = perspective !== "observer";
  const joinable = participant && (phase === "joinable" || phase === "live");
  const other =
    perspective === "invitee"
      ? invite.hostName
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
            <span className="inline-flex items-center gap-1.5">
              <User className="h-3.5 w-3.5" />
              {other ? (
                <>
                  {perspective === "host" ? "With" : "From"} {other}
                  {perspective === "invitee" && (
                    <span className="font-mono uppercase tracking-wider text-ink-faint/80">
                      {invite.hostRole}
                    </span>
                  )}
                </>
              ) : (
                // The observer sees both names — whose call it is is the whole
                // question the safeguarding list exists to answer.
                <>
                  {invite.hostName}
                  <span className="font-mono uppercase tracking-wider text-ink-faint/80">
                    {invite.hostRole}
                  </span>
                  <span aria-hidden>→</span>
                  {invite.inviteeName}
                </>
              )}
            </span>
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

          {recordingParts > 0 && (
            <RecordingLinks inviteId={invite.id} parts={recordingParts} />
          )}
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
            <ButtonLink size="sm" href={`/dashboard/calls/${invite.id}/live`}>
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

          {perspective === "host" &&
            onCancel &&
            now &&
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
    </div>
  );
}

/**
 * "Recording · Part 1 · Part 2".
 *
 * Each part is a link to /api/calls/<id>/recording/<n>, which checks the
 * viewer against the call and only then mints a ten-minute signed URL — so
 * nothing on this page is itself a working link to the file. Parts rather
 * than one file because that is what the recorder writes (two-minute
 * segments, so a crash costs one and not the call), and stitching them
 * server-side is a transcode this change does not take on.
 */
function RecordingLinks({ inviteId, parts }: { inviteId: string; parts: number }) {
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
      <span className="inline-flex items-center gap-1.5 font-medium text-ink">
        <CircleDot className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
        Recording
        <span className="font-normal text-ink-faint">
          ({parts} {parts === 1 ? "part" : "parts"})
        </span>
      </span>
      {Array.from({ length: parts }, (_, i) => (
        <a
          key={i}
          href={`/api/calls/${inviteId}/recording/${i + 1}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-phosphor-ink underline-offset-2 hover:underline"
        >
          Part {i + 1}
        </a>
      ))}
    </p>
  );
}

/** A list of invites with an empty state, used on every calls page. */
export function InviteList({
  invites,
  perspective,
  emptyMessage,
  now,
  recordings,
  onAccept,
  onDecline,
  onCancel,
  pending,
}: {
  invites: CallInvite[];
  perspective: InvitePerspective;
  emptyMessage: string;
  now?: Date | null;
  /** inviteId → recorded parts. Only ever passed to people allowed to watch. */
  recordings?: Record<string, number>;
  onAccept?: (id: string) => void;
  onDecline?: (id: string) => void;
  onCancel?: (id: string) => void;
  pending?: boolean;
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
          recordingParts={recordings?.[i.id] ?? 0}
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
  recordings,
  emptyMessage,
  onCancel,
  pending,
}: {
  invites: CallInvite[];
  perspective: InvitePerspective;
  /** The server's render time, as ISO. See `useNow`. */
  now: string;
  recordings?: Record<string, number>;
  emptyMessage: string;
  onCancel?: (id: string) => void;
  pending?: boolean;
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
        recordings={recordings}
        emptyMessage={
          past.length > 0 ? "Nothing coming up. Past calls are below." : emptyMessage
        }
        onCancel={onCancel}
        pending={pending}
      />
      <PastCalls count={past.length} className="mt-8">
        {/* Cancel is wired here too, for the one past card that offers it:
            an invite that expired unanswered, which the host can withdraw
            (canCancelCall decides; every other past card shows no button). */}
        <InviteList
          invites={past}
          perspective={perspective}
          now={now}
          recordings={recordings}
          emptyMessage=""
          onCancel={onCancel}
          pending={pending}
        />
      </PastCalls>
    </>
  );
}
