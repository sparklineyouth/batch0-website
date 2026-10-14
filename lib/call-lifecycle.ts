/**
 * Where a 1:1 call is in its life — derived from its status and the clock,
 * never stored.
 *
 * `call_invites.status` records decisions (invited, accepted, declined,
 * cancelled, completed). There is no accept gate: an `invited` call is a
 * booked call, joinable exactly like an `accepted` one (legacy rows), and the
 * student may still decline it. The room's windows live here (callWindow) and
 * the room's access gate (lib/live-access.ts) applies the same ones: the staff
 * side may enter from start − 60 min, the student from start − 15 min, and the
 * room stays open until End call, a cancel, or the hard close at end + 3 h.
 *
 * Pure, like lib/live.ts: the one import is that module, by relative path
 * with its extension, so `node --test` runs it with no transpile step.
 */
import {
  isOnCall,
  normalizeCohostIds,
  MAX_CALL_COHOSTS,
  type CallInviteStatus,
  type CallParties,
} from "./live.ts";

const MINUTE = 60_000;

/** The room opens this early for the staff side (setting up, waiting for the student). */
export const CALL_STAFF_OPENS_MINUTES_BEFORE = 60;
/** The room opens this early for the student. */
export const CALL_STUDENT_OPENS_MINUTES_BEFORE = 15;
/** Past the scheduled end, the room stays open this long unless someone ends it. */
export const CALL_HARD_CLOSE_MINUTES_AFTER = 180;

/** The facts every phase question needs. `CallInvite` satisfies it. */
export type CallTiming = {
  status: CallInviteStatus;
  startsAt: string;
  durationMinutes: number;
  /** When the row last changed — dates a cancellation (mayHaveCallRecording). */
  updatedAt?: string;
};

/** Which side of the call is asking: their room opens at different times. */
export type CallSide = "staff" | "student";

export type CallPhase =
  /** Invited (not declined), room not open yet for this side. The student may still decline. */
  | "needs_answer"
  /** Accepted (legacy rows and old confirmations), room not open yet. */
  | "upcoming"
  /** Room open, before the scheduled start. */
  | "joinable"
  /** From the start until End call, a cancel, or the hard close. */
  | "live"
  /** Past the hard close and nobody pressed End call; the sweep stamps it completed. */
  | "ended"
  | "completed"
  | "declined"
  | "cancelled";

/** When the call is scheduled to finish. */
export function callEndsAt(startsAt: string | Date, durationMinutes: number): Date {
  return new Date(new Date(startsAt).getTime() + durationMinutes * MINUTE);
}

/** The instants that bound one call's room, for one side, in epoch ms. */
export function callWindow(
  call: Pick<CallTiming, "startsAt" | "durationMinutes">,
  side: CallSide = "student",
): { opensAt: number; start: number; end: number; hardCloseAt: number } {
  const start = new Date(call.startsAt).getTime();
  const end = start + call.durationMinutes * MINUTE;
  const early =
    side === "staff" ? CALL_STAFF_OPENS_MINUTES_BEFORE : CALL_STUDENT_OPENS_MINUTES_BEFORE;
  return {
    opensAt: start - early * MINUTE,
    start,
    end,
    hardCloseAt: end + CALL_HARD_CLOSE_MINUTES_AFTER * MINUTE,
  };
}

/**
 * The one answer to "what is this call right now", for one side.
 *
 * An unrecognised status reads as cancelled: offering a button for a value
 * this build does not know would be a guess.
 */
export function callPhase(
  call: CallTiming,
  now: Date = new Date(),
  side: CallSide = "student",
): CallPhase {
  // An if-chain, not a switch: the production minifier once mis-compiled a
  // switch with a falling-out case group here, and every call came out
  // `undefined` while the unminified tests passed.
  const status = call.status;
  if (status === "cancelled" || status === "declined" || status === "completed") {
    return status;
  }
  if (status !== "invited" && status !== "accepted") return "cancelled";

  const w = callWindow(call, side);
  const t = now.getTime();
  if (t > w.hardCloseAt) return "ended";
  if (t >= w.start) return "live";
  if (t >= w.opensAt) return "joinable";
  return status === "invited" ? "needs_answer" : "upcoming";
}

/** Belongs under "Past": nothing left to do but look at it. */
export function isPastPhase(phase: CallPhase): boolean {
  return (
    phase === "ended" ||
    phase === "completed" ||
    phase === "declined" ||
    phase === "cancelled"
  );
}

/** The room is open to this side right now. */
export function isRoomOpenPhase(phase: CallPhase): boolean {
  return phase === "joinable" || phase === "live";
}

/** Still ahead or running: everything a person can still act on. */
function isActivePhase(phase: CallPhase): boolean {
  return phase === "needs_answer" || phase === "upcoming" || isRoomOpenPhase(phase);
}

/** The student may still say they can't make it: any booked call that isn't over. */
export function canDeclineCall(call: CallTiming, now: Date = new Date()): boolean {
  return isActivePhase(callPhase(call, now));
}

/**
 * The staff side (or an admin) may still cancel — right up to the hard close,
 * including while live: a host waiting on a no-show cancels, which is also
 * what hands a scholarship credit back. Never once the call is over.
 */
export function canCancelCall(call: CallTiming, now: Date = new Date()): boolean {
  return isActivePhase(callPhase(call, now, "staff"));
}

/** The staff side may still move it, change its length or its topic. */
export function canEditCall(call: CallTiming, now: Date = new Date()): boolean {
  return isActivePhase(callPhase(call, now, "staff"));
}

/** People may be added exactly while the call can still happen. */
export function canAddCallCohosts(call: CallTiming, now: Date = new Date()): boolean {
  return isActivePhase(callPhase(call, now, "staff"));
}

/**
 * End call may mark this call completed: booked, and the room has opened for
 * the staff side. Past the hard close is fine too — it is what the sweep does.
 */
export function canMarkCallCompleted(call: CallTiming, now: Date = new Date()): boolean {
  if (call.status !== "invited" && call.status !== "accepted") return false;
  return now.getTime() >= callWindow(call, "staff").opensAt;
}

/** How long after the hard close a final recording part may still upload. */
export const RECORDING_UPLOAD_GRACE_MINUTES = 10;

/**
 * May the staff side upload recording for this call right now? Booked,
 * completed (the other person pressed End while the recorder flushed) or
 * cancelled (cancelled from another tab while in the room), between the room
 * opening and a short grace after the hard close.
 */
export function canUploadCallRecording(
  call: CallTiming,
  now: Date = new Date(),
): boolean {
  if (
    call.status !== "invited" &&
    call.status !== "accepted" &&
    call.status !== "completed" &&
    call.status !== "cancelled"
  ) {
    return false;
  }
  const w = callWindow(call, "staff");
  const t = now.getTime();
  return t >= w.opensAt && t <= w.hardCloseAt + RECORDING_UPLOAD_GRACE_MINUTES * MINUTE;
}

/**
 * Could this call have a recording? Booked or completed once its room could
 * have opened; cancelled only when it was cancelled while the room was open
 * (`updatedAt` dates the cancel; without one, fall back to "could it have
 * opened yet"). Declined calls never had a room.
 */
export function mayHaveCallRecording(call: CallTiming, now: Date = new Date()): boolean {
  if (call.status === "completed") return true;
  const w = callWindow(call, "staff");
  if (!(w.opensAt <= now.getTime())) return false;
  if (call.status === "invited" || call.status === "accepted") return true;
  if (call.status !== "cancelled") return false;
  const at = call.updatedAt ? Date.parse(call.updatedAt) : NaN;
  if (!Number.isFinite(at)) return true;
  return at >= w.opensAt && at <= w.hardCloseAt;
}

/** What /api/cron/call-lifecycle stamps `completed`: booked, and past the hard close. */
export function shouldAutoComplete(call: CallTiming, now: Date = new Date()): boolean {
  return (
    (call.status === "invited" || call.status === "accepted") &&
    callPhase(call, now, "staff") === "ended"
  );
}

/** How far back the sweep looks. Older rows are history it leaves alone. */
export const AUTO_COMPLETE_LOOKBACK_DAYS = 7;

/**
 * The sweep's `starts_at` prefilter: [from, to]. `to` is the latest start that
 * can be past its hard close by `now` (the shortest call the CHECK allows is
 * five minutes); `shouldAutoComplete` decides each row exactly.
 */
export function autoCompleteRange(now: Date = new Date()): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - AUTO_COMPLETE_LOOKBACK_DAYS * 24 * 60 * MINUTE),
    to: new Date(now.getTime() - (CALL_HARD_CLOSE_MINUTES_AFTER + MIN_CALL_MINUTES) * MINUTE),
  };
}

/**
 * Split a list of calls into what is still ahead and what is over: upcoming
 * soonest first, past newest first. Split on the staff side's clock so a call
 * never jumps between sections depending on who is looking.
 */
export function splitCalls<T extends CallTiming>(
  calls: readonly T[],
  now: Date = new Date(),
): { upcoming: T[]; past: T[] } {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const c of calls) {
    (isPastPhase(callPhase(c, now, "staff")) ? past : upcoming).push(c);
  }
  const t = (c: T) => new Date(c.startsAt).getTime();
  upcoming.sort((a, b) => t(a) - t(b));
  past.sort((a, b) => t(b) - t(a));
  return { upcoming, past };
}

/** The word on a call's badge. A live call shows the pulsing dot instead. */
export function callBadge(phase: CallPhase): string {
  if (phase === "needs_answer" || phase === "upcoming") return "scheduled";
  if (phase === "joinable") return "open";
  return phase;
}

/** Earliest a new call may start: a few minutes back, so "now" survives a slow click. */
export const START_GRACE_MINUTES = 5;
export const MIN_CALL_MINUTES = 5;
export const MAX_CALL_MINUTES = 240;

/** Why this start time can't be booked, or null. */
export function callStartProblem(startsAt: Date, now: Date = new Date()): string | null {
  if (Number.isNaN(startsAt.getTime())) return "That time isn't valid.";
  if (startsAt.getTime() < now.getTime() - START_GRACE_MINUTES * MINUTE) {
    return "That time is in the past.";
  }
  return null;
}

/** Why this length can't be booked, or null. */
export function callDurationProblem(minutes: number): string | null {
  if (!Number.isFinite(minutes)) return "Pick how long the call runs.";
  const m = Math.round(minutes);
  if (m < MIN_CALL_MINUTES || m > MAX_CALL_MINUTES) {
    return `Calls run between ${MIN_CALL_MINUTES} and ${MAX_CALL_MINUTES} minutes.`;
  }
  return null;
}

/** "Start call now" starts on the current minute. */
export function startOfMinute(now: Date = new Date()): Date {
  return new Date(Math.floor(now.getTime() / MINUTE) * MINUTE);
}

// ---------------------------------------------------------------------------
// "Request a 1:1" (interview_requests, migration 0061)
// ---------------------------------------------------------------------------

/**
 * Any enrolled student, whenever they want; staff previewing the dashboard
 * read as enrolled but cannot file one. The database allows one open request.
 */
export function canRequestTeamCall(access: {
  enrolled: boolean;
  staff: boolean;
}): boolean {
  return access.enrolled && !access.staff;
}

/**
 * What the student's request card shows on /dashboard/calls.
 *
 *   requested  waiting on the team, with Withdraw
 *   hidden     its call is booked and still ahead (it is in the list), or
 *              this person may not ask
 *   compose    the ask
 *
 * A scheduled request whose call is over or fell through gives way to a
 * fresh ask; the request's own status stays `scheduled` for ever, so it is
 * read through its call.
 */
export type RequestCardState = "compose" | "requested" | "hidden";

export function requestCardState(
  request: { status: string; call: CallTiming | null } | null,
  canAsk: boolean,
  now: Date = new Date(),
): RequestCardState {
  if (request?.status === "requested") return "requested";
  if (
    request?.status === "scheduled" &&
    request.call &&
    !isPastPhase(callPhase(request.call, now))
  ) {
    return "hidden";
  }
  return canAsk ? "compose" : "hidden";
}

/** Every time the student proposed has gone by (false when they proposed none). */
export function proposalsAllPast(
  preferredAt: string | null,
  altAt: string | null,
  now: Date = new Date(),
): boolean {
  const proposed = [preferredAt, altAt].filter(
    (v): v is string => !!v && Number.isFinite(Date.parse(v)),
  );
  if (proposed.length === 0) return false;
  return proposed.every((v) => Date.parse(v) <= now.getTime());
}

/** The booking form's starting time: the student's first proposal still ahead, or null. */
export function bookingPrefill(
  preferredAt: string | null,
  altAt: string | null,
  now: Date = new Date(),
): string | null {
  for (const v of [preferredAt, altAt]) {
    if (v && Number.isFinite(Date.parse(v)) && Date.parse(v) > now.getTime()) {
      return v;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Who may do what, and where they go afterwards
// ---------------------------------------------------------------------------

/**
 * May this person watch the call back? The people on it and admins — the
 * safeguarding rule. Holding `calls.invite` is for booking your OWN calls.
 */
export function canViewCallRecording(args: {
  viewerId: string;
  hostId: string;
  inviteeId: string;
  cohostIds?: readonly string[];
  superAdmin: boolean;
}): boolean {
  return (
    args.superAdmin ||
    isOnCall(
      {
        hostId: args.hostId,
        inviteeId: args.inviteeId,
        cohosts: (args.cohostIds ?? []).map((id) => ({ id })),
      },
      args.viewerId,
    )
  );
}

/**
 * What adding people to an existing call would do: who in the request is new
 * (cleaned like the invite form's, minus anyone already a co-host), and
 * whether they fit under MAX_CALL_COHOSTS counted on the call's TOTAL.
 */
export function cohostsToAdd(
  requested: readonly unknown[] | null | undefined,
  call: CallParties,
): { ids: string[]; room: number; fits: boolean } {
  const parties = { hostId: call.hostId, inviteeId: call.inviteeId };
  const already = normalizeCohostIds(
    call.cohosts.map((c) => c.id),
    parties,
  );
  const ids = normalizeCohostIds(requested, parties).filter(
    (id) => !already.includes(id),
  );
  const room = Math.max(0, MAX_CALL_COHOSTS - already.length);
  return { ids, room, fits: ids.length <= room };
}

/** A staff member's own calls list — where "back" and their notifications go. */
export function hostCallsHref(caps: {
  superAdmin: boolean;
  mentorPanel: boolean;
  investorPanel: boolean;
  canInvite: boolean;
}): string {
  if (caps.superAdmin) return "/admin/calls";
  if (caps.mentorPanel) return "/mentor/calls";
  if (caps.investorPanel) return "/investor/calls";
  if (caps.canInvite) return "/admin/calls";
  return "/dashboard/calls";
}

// ---------------------------------------------------------------------------
// Times in email
// ---------------------------------------------------------------------------

/**
 * "Saturday, September 19, 2026 at 5:30 PM EDT". Email can't know the
 * reader's zone, so Eastern with the zone named; the .ics link carries the
 * exact instant.
 */
export function formatEasternDateTime(iso: string | Date): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tz = "America/New_York";
  const date = d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
  const zone =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? "ET";
  return `${date} at ${time} ${zone}`;
}
