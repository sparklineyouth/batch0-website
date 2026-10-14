/**
 * Where a 1:1 call is in its life — derived from its status and the clock,
 * never stored.
 *
 * `call_invites.status` records decisions (invited, accepted, declined,
 * cancelled, completed). There is no accept gate: an `invited` call is a
 * booked call, joinable exactly like an `accepted` one (legacy rows), and the
 * student may decline it until it starts. The numbers are lib/live.ts's, and
 * the room's door (lib/live-access.ts) applies the same windows: the staff
 * side may enter from start − 60 min, the student from start − 15 min, and
 * the room stays open until End call, a cancel, or the hard close at
 * end + 3 h. Lists are calmer than the door: a call nobody ended reads as
 * over 30 minutes after its scheduled end (callListPhase), like a webinar's
 * card.
 *
 * Pure, like lib/live.ts: the one import is that module, by relative path
 * with its extension, so `node --test` runs it with no transpile step.
 */
import {
  CALL_STAFF_OPENS_MINUTES_BEFORE,
  isOnCall,
  JOIN_CLOSES_MINUTES_AFTER,
  JOIN_OPENS_MINUTES_BEFORE,
  normalizeCohostIds,
  MAX_CALL_COHOSTS,
  ROOM_HARD_CLOSE_MINUTES_AFTER,
  type CallInviteStatus,
  type CallParties,
} from "./live.ts";

const MINUTE = 60_000;

/** The room opens this early for the staff side (setting up, waiting for the student). */
export { CALL_STAFF_OPENS_MINUTES_BEFORE };
/** The room opens this early for the student: the audience's window. */
export const CALL_STUDENT_OPENS_MINUTES_BEFORE = JOIN_OPENS_MINUTES_BEFORE;
/** Past the scheduled end, the room stays open this long unless someone ends it. */
export const CALL_HARD_CLOSE_MINUTES_AFTER = ROOM_HARD_CLOSE_MINUTES_AFTER;
/**
 * Past the scheduled end, a call nobody ended still reads "running over" in
 * the lists for this long, then as over. The webinar lists' rule.
 */
export const CALL_LIST_GRACE_MINUTES = JOIN_CLOSES_MINUTES_AFTER;

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
  /** From the start until End call, a cancel, or the hard close (lists: see callListPhase). */
  | "live"
  /** Nobody pressed End call and it is over: past the hard close (lists: past the grace). */
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

function isBooked(call: CallTiming): boolean {
  return call.status === "invited" || call.status === "accepted";
}

/**
 * Where the call's ROOM stands for one side: the door's answer. Open from the
 * side's early window to the hard close.
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
  if (!isBooked(call)) return "cancelled";

  const w = callWindow(call, side);
  const t = now.getTime();
  if (t > w.hardCloseAt) return "ended";
  if (t >= w.start) return "live";
  if (t >= w.opensAt) return "joinable";
  return status === "invited" ? "needs_answer" : "upcoming";
}

/**
 * What a calls LIST says about the call: callPhase, except that a call nobody
 * ended reads "ended" once it is CALL_LIST_GRACE_MINUTES past its scheduled
 * end. Most calls end with a tab closing, not End call, and one that happened
 * an hour ago must not sit under Upcoming with "Join now". Anyone still in
 * the room keeps it to the hard close; the card offers Rejoin meanwhile.
 */
export function callListPhase(
  call: CallTiming,
  now: Date = new Date(),
  side: CallSide = "student",
): CallPhase {
  const phase = callPhase(call, now, side);
  if (phase !== "live") return phase;
  const listEnd = callWindow(call, side).end + CALL_LIST_GRACE_MINUTES * MINUTE;
  return now.getTime() > listEnd ? "ended" : "live";
}

/** Live, and past its scheduled end: the list's "running over". */
export function isRunningOver(call: CallTiming, now: Date = new Date()): boolean {
  return (
    callListPhase(call, now, "staff") === "live" &&
    now.getTime() > callWindow(call, "staff").end
  );
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

/** Still ahead or running, as the lists read it: what a person can still act on. */
function isActive(call: CallTiming, now: Date): boolean {
  const phase = callListPhase(call, now, "staff");
  return phase === "needs_answer" || phase === "upcoming" || isRoomOpenPhase(phase);
}

/**
 * The student may say they can't make it until the call starts. Not after: a
 * call that has started (or happened) is not declined — that would hand back
 * a scholarship credit for a call that took place and hide its recording. A
 * host facing a no-show cancels instead.
 */
export function canDeclineCall(call: CallTiming, now: Date = new Date()): boolean {
  return isBooked(call) && now.getTime() < callWindow(call).start;
}

/**
 * The staff side (or an admin) may cancel until the list's grace past the
 * scheduled end — a host who waited for a no-show cancels, which is also
 * what hands a scholarship credit back. Not later: the call happened, and
 * cancelling would refund the credit it used and tell the student it was
 * cancelled.
 */
export function canCancelCall(call: CallTiming, now: Date = new Date()): boolean {
  return isActive(call, now);
}

/** The staff side may still move it, change its length or its topic. */
export function canEditCall(call: CallTiming, now: Date = new Date()): boolean {
  return isActive(call, now);
}

/** People may be added exactly while the call is under Upcoming. */
export function canAddCallCohosts(call: CallTiming, now: Date = new Date()): boolean {
  return isActive(call, now);
}

/**
 * End call may mark this call completed: booked, and it has started. Two
 * people who met early in the staff room and left have not HAD the call yet,
 * and completing it would shut the student's room before it opens. Past the
 * hard close is fine too — it is what the sweep does.
 */
export function canMarkCallCompleted(call: CallTiming, now: Date = new Date()): boolean {
  return isBooked(call) && now.getTime() >= callWindow(call).start;
}

/** How long after the hard close a final recording part may still upload. */
export const RECORDING_UPLOAD_GRACE_MINUTES = 10;

/**
 * May the staff side upload recording for this call right now? Booked,
 * completed (the other person pressed End while the recorder flushed),
 * cancelled or declined (while the staff side was in the room), between the
 * staff room opening and a short grace after the hard close.
 */
export function canUploadCallRecording(
  call: CallTiming,
  now: Date = new Date(),
): boolean {
  if (call.status !== "completed" && !isBooked(call) && !isCalledOff(call)) return false;
  const w = callWindow(call, "staff");
  const t = now.getTime();
  return t >= w.opensAt && t <= w.hardCloseAt + RECORDING_UPLOAD_GRACE_MINUTES * MINUTE;
}

function isCalledOff(call: CallTiming): boolean {
  return call.status === "cancelled" || call.status === "declined";
}

/**
 * Could this call have a recording? Booked or completed once its staff room
 * could have opened; cancelled or declined only when that happened while the
 * staff room was open (`updatedAt` dates it; without one, fall back to "could
 * it have opened yet").
 */
export function mayHaveCallRecording(call: CallTiming, now: Date = new Date()): boolean {
  if (call.status === "completed") return true;
  const w = callWindow(call, "staff");
  if (!(w.opensAt <= now.getTime())) return false;
  if (isBooked(call)) return true;
  if (!isCalledOff(call)) return false;
  const at = call.updatedAt ? Date.parse(call.updatedAt) : NaN;
  if (!Number.isFinite(at)) return true;
  return at >= w.opensAt && at <= w.hardCloseAt;
}

// ---------------------------------------------------------------------------
// The sweep (/api/cron/call-lifecycle)
// ---------------------------------------------------------------------------

/**
 * Until this instant a call's room opened only once the student pressed
 * Accept. An `invited` row whose room had already closed by then (end + 30
 * min, the old window) is an invite nobody answered: nobody could have
 * joined it. The sweep withdraws those rather than completing them.
 */
export const ACCEPT_STEP_REMOVED_AT = "2026-10-14T03:00:00.000Z";

/** An invite that expired unanswered under the accept step (see ACCEPT_STEP_REMOVED_AT). */
export function expiredUnderAcceptStep(call: CallTiming): boolean {
  if (call.status !== "invited") return false;
  const oldClose = callWindow(call).end + JOIN_CLOSES_MINUTES_AFTER * MINUTE;
  return oldClose < Date.parse(ACCEPT_STEP_REMOVED_AT);
}

/**
 * What the sweep stamps `completed`: booked, past the hard close, and not an
 * invite that expired unanswered under the accept step. Booked calls nobody
 * cancelled count as held — a no-show's scholarship credit stays spent unless
 * the host cancels (canCancelCall) or the student declines beforehand.
 */
export function shouldAutoComplete(call: CallTiming, now: Date = new Date()): boolean {
  return (
    isBooked(call) &&
    !expiredUnderAcceptStep(call) &&
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

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * Split a list of calls into what is still ahead and what is over: upcoming
 * soonest first, past newest first. Split on the staff side's list phase, so
 * a call never jumps between sections depending on who is looking.
 */
export function splitCalls<T extends CallTiming>(
  calls: readonly T[],
  now: Date = new Date(),
): { upcoming: T[]; past: T[] } {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const c of calls) {
    (isPastPhase(callListPhase(c, now, "staff")) ? past : upcoming).push(c);
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
 *   compose    the ask — also while a booked call is ahead (it is in the list
 *              below), so a scholarship balance and the next request are
 *              never out of sight
 *   hidden     this person may not ask
 *
 * The database allows one WAITING request per student; booked ones don't
 * count against it.
 */
export type RequestCardState = "compose" | "requested" | "hidden";

export function requestCardState(
  request: { status: string } | null,
  canAsk: boolean,
): RequestCardState {
  if (request?.status === "requested") return "requested";
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
