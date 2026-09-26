/**
 * Where a 1:1 call is in its life — derived, never stored.
 *
 * `call_invites.status` records the DECISIONS people made (invited, accepted,
 * declined, cancelled, completed). It does not record the passage of time, and
 * until this module existed nothing looked at the clock at all: an accepted
 * call from last week sat under "Upcoming" forever, a past invite could still
 * be accepted into a call nobody could ever join, and a host could "cancel" a
 * call that had already happened — notifying the student and refunding a
 * scholarship credit for time that was genuinely spent.
 *
 * So every surface that asks "what is this call right now" asks here, with
 * the status AND the clock, and gets one answer. The rule for "over" is the
 * same one the join gate already uses (`joinState` in lib/live.ts): a call is
 * ended once its join window has closed, JOIN_CLOSES_MINUTES_AFTER past the
 * scheduled end. Anything earlier than that and someone may still be in the
 * room, running over — calling it "done" then would pull the Join button out
 * from under them.
 *
 * `completed` is still written — by the End call button and by the
 * /api/cron/call-lifecycle sweep — so the database eventually agrees with
 * what this module derives. But nothing waits on that write: a call whose
 * window closed a minute ago reads as ended everywhere, whether or not the
 * cron has run yet.
 *
 * Pure, like lib/live.ts: the one import is that module, by relative path
 * with its extension, so `node --test` can run it with no transpile step.
 */
import {
  joinState,
  JOIN_OPENS_MINUTES_BEFORE,
  JOIN_CLOSES_MINUTES_AFTER,
  type CallInviteStatus,
} from "./live.ts";

const MINUTE = 60_000;

/** The three facts every phase question needs. `CallInvite` satisfies it. */
export type CallTiming = {
  status: CallInviteStatus;
  startsAt: string;
  durationMinutes: number;
};

export type CallPhase =
  /** Invited, and the window has not closed — the invitee still owes an answer. */
  | "needs_answer"
  /**
   * Invited, and the window closed with nobody answering. Derived rather than
   * stored: the status CHECK allows no such value, and "the time came and
   * went" is a fact about the clock, not a decision anyone made.
   */
  | "expired"
  /** Accepted; the room is not open yet. */
  | "upcoming"
  /** Accepted; the room is open (the early window) but the start has not come. */
  | "joinable"
  /** Accepted; past the start and still inside the window. */
  | "live"
  /**
   * Accepted, and the window has closed. What `completed` looks like before
   * the sweep has stamped it — to a person, the two are the same call.
   */
  | "ended"
  | "completed"
  | "declined"
  | "cancelled";

/** When the call is scheduled to finish. The window closes 30 minutes later. */
export function callEndsAt(startsAt: string | Date, durationMinutes: number): Date {
  return new Date(new Date(startsAt).getTime() + durationMinutes * MINUTE);
}

/**
 * The one answer to "what is this call right now".
 *
 * An unrecognised status is treated as cancelled — not joinable, not
 * answerable, not cancellable — because a value this build does not know about
 * is exactly the case where offering a button would be a guess.
 */
export function callPhase(call: CallTiming, now: Date = new Date()): CallPhase {
  // Deliberately an if-chain, not `switch (call.status) { … case "accepted":
  // break; default: return … }`. That shape — a case group that falls out of
  // the switch next to a returning `default` — is exactly what the production
  // minifier mis-compiled: it folded `default` into "cancelled" and dropped
  // every statement after the switch, so each invited/accepted call came out
  // with phase `undefined` (never past, never joinable, never answerable) while
  // the unminified tests passed. Found by probing the deployed preview bundle.
  const status = call.status;
  if (status === "cancelled" || status === "declined" || status === "completed") {
    return status;
  }
  if (status !== "invited" && status !== "accepted") return "cancelled";

  const state = joinState(
    call.startsAt,
    callEndsAt(call.startsAt, call.durationMinutes),
    now,
  );
  if (status === "invited") return state === "ended" ? "expired" : "needs_answer";
  if (state === "early") return "upcoming";
  if (state === "open") return "joinable";
  if (state === "live") return "live";
  return "ended";
}

/** Belongs under "Past": nothing left to do but look at it. */
export function isPastPhase(phase: CallPhase): boolean {
  return (
    phase === "expired" ||
    phase === "ended" ||
    phase === "completed" ||
    phase === "declined" ||
    phase === "cancelled"
  );
}

/** The invitee may still accept or decline. */
export function canRespondToCall(call: CallTiming, now: Date = new Date()): boolean {
  return callPhase(call, now) === "needs_answer";
}

/**
 * The host (or an admin) may still cancel.
 *
 * Right up to the window closing, including while the call is live — a host
 * waiting on a student who never arrived is exactly who needs this, and it is
 * what hands a scholarship credit back for a call that never happened. After
 * an ACCEPTED call's window closes, never: the call is history, and
 * cancelling history would tell a student that a meeting they already had was
 * called off.
 *
 * An invite that EXPIRED unanswered is the exception, and it is withdrawing
 * rather than cancelling: nobody ever agreed to that call, so nothing that
 * happened is being rewritten. It matters because of what the invite may be
 * holding. A scholarship call spends its credit when it is booked, and an
 * expired invite can no longer be declined (the student's refund path) or
 * cancelled by the old rule — so without this the credit was gone for good,
 * for a call nobody had. Withdrawing runs the same once-only refund a cancel
 * does. (The call-lifecycle sweep also withdraws scholarship invites on its
 * own; this is the host's way to tidy one up before it runs.)
 */
export function canCancelCall(call: CallTiming, now: Date = new Date()): boolean {
  const phase = callPhase(call, now);
  return (
    phase === "needs_answer" ||
    phase === "expired" ||
    phase === "upcoming" ||
    phase === "joinable" ||
    phase === "live"
  );
}

/**
 * Pressing End call may mark this call completed.
 *
 * Accepted, and the scheduled start has arrived. Not before the start: two
 * people who joined ten minutes early and left again have not HAD the call,
 * and marking it completed would close a room that is meant to open for them
 * at the proper time. Past the window is fine — it is what the sweep would do
 * anyway, and refusing would only make the button look broken.
 */
export function canMarkCallCompleted(call: CallTiming, now: Date = new Date()): boolean {
  return (
    call.status === "accepted" &&
    now.getTime() >= new Date(call.startsAt).getTime()
  );
}

/**
 * How long after the join window closes a recording segment may still be
 * uploaded.
 *
 * The room closes itself when the window does (it polls for exactly that), and
 * closing FLUSHES the recorder — so the last segment of a call that ran right
 * to the wire is finished at the moment the window shuts and uploaded just
 * after it. Without a grace, the gate that refuses uploads for a closed call
 * refused that segment: up to two minutes, and always the end of the
 * conversation. Ten minutes covers the recorder's ninety-second drain on a
 * slow uplink with room to spare, and is still a door that shuts.
 */
export const RECORDING_UPLOAD_GRACE_MINUTES = 10;

/**
 * May the host upload a recording segment for this call right now?
 *
 * Accepted, or completed — when the OTHER person presses End call the row
 * flips to completed while the host's recorder is still flushing, and refusing
 * that upload would cut the end off every call the student closed. Or
 * cancelled, for the same reason: a host who cancels from another tab while
 * sitting in the room (waiting on a student who never came) has a recorder
 * that flushes when the room notices, and that last segment belongs with the
 * rest. From the moment the room opens until the grace after it closes; never
 * for a call next week or last week, whatever its status.
 */
export function canUploadCallRecording(
  call: CallTiming,
  now: Date = new Date(),
): boolean {
  if (
    call.status !== "accepted" &&
    call.status !== "completed" &&
    call.status !== "cancelled"
  ) {
    return false;
  }
  const start = new Date(call.startsAt).getTime();
  const closes =
    callEndsAt(call.startsAt, call.durationMinutes).getTime() +
    (JOIN_CLOSES_MINUTES_AFTER + RECORDING_UPLOAD_GRACE_MINUTES) * MINUTE;
  const t = now.getTime();
  return t >= start - JOIN_OPENS_MINUTES_BEFORE * MINUTE && t <= closes;
}

/** What /api/cron/call-lifecycle stamps `completed`: accepted, window closed. */
export function shouldAutoComplete(call: CallTiming, now: Date = new Date()): boolean {
  return call.status === "accepted" && callPhase(call, now) === "ended";
}

/**
 * What /api/cron/call-lifecycle withdraws: an invite whose window closed with
 * nobody answering. The sweep narrows this further to invites that are holding
 * a scholarship credit (a fact on another table), because withdrawing one is
 * how that credit is handed back; an ordinary expired invite is left alone.
 */
export function shouldAutoWithdraw(call: CallTiming, now: Date = new Date()): boolean {
  return call.status === "invited" && callPhase(call, now) === "expired";
}

/**
 * Could this call have recording segments in storage?
 *
 * Accepted or completed: the host was recording from the moment the room
 * opened. Cancelled, too, once the room could have opened — a call cancelled
 * mid-room (a host giving up on a no-show) has segments, and the room tells
 * the host they are "under Past", so the Past list has to look. A call
 * cancelled days before its time has nothing, but cannot be told apart from
 * one cancelled mid-room without a timestamp the table does not have; the
 * cost of asking is one empty storage listing. Declined and never-answered
 * invites never had a room.
 */
export function mayHaveCallRecording(call: CallTiming, now: Date = new Date()): boolean {
  if (call.status === "accepted" || call.status === "completed") return true;
  if (call.status !== "cancelled") return false;
  return (
    new Date(call.startsAt).getTime() - JOIN_OPENS_MINUTES_BEFORE * MINUTE <=
    now.getTime()
  );
}

/**
 * The earliest `starts_at` that can possibly have closed by `now`.
 *
 * The sweep's database prefilter: the shortest call the CHECK allows is five
 * minutes, so anything that started later than this cannot be over yet and is
 * not worth reading. `shouldAutoComplete` makes the exact decision per row —
 * this only keeps the candidate list short.
 */
export function autoCompleteCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - (JOIN_CLOSES_MINUTES_AFTER + 5) * MINUTE);
}

/**
 * Split a list of calls into what is still ahead and what is over, each in
 * the order a person reads it.
 *
 * Upcoming is SOONEST first: the next call is the one you need, and the old
 * newest-first order put the call furthest in the future at the top of a list
 * headed "Upcoming". Past is newest first, like any history.
 */
export function splitCalls<T extends CallTiming>(
  calls: readonly T[],
  now: Date = new Date(),
): { upcoming: T[]; past: T[] } {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const c of calls) {
    (isPastPhase(callPhase(c, now)) ? past : upcoming).push(c);
  }
  const t = (c: T) => new Date(c.startsAt).getTime();
  upcoming.sort((a, b) => t(a) - t(b));
  past.sort((a, b) => t(b) - t(a));
  return { upcoming, past };
}

/**
 * The word on a call's badge. A live call shows the pulsing dot instead, so
 * `live` is here only for completeness.
 *
 * `needs_answer` reads "invited" to both sides, which is the fact; the section
 * heading above it is what tells the student it is theirs to answer.
 */
export function callBadge(phase: CallPhase): string {
  switch (phase) {
    case "needs_answer":
      return "invited";
    case "upcoming":
    case "joinable":
      return "accepted";
    case "live":
      return "live";
    case "ended":
      return "ended";
    case "expired":
      return "expired";
    case "completed":
      return "completed";
    case "declined":
      return "declined";
    case "cancelled":
      return "cancelled";
  }
}

// ---------------------------------------------------------------------------
// Getting-to-know-you interviews (interview_requests, migration 0061)
// ---------------------------------------------------------------------------

/**
 * Where a student's interview request stands, read through the call it booked.
 *
 * A request's own status stops at `scheduled` — nothing moves it on, and the
 * CHECK has no value to move it to. What happens after booking lives on the
 * linked call_invites row, so this looks there:
 *
 *   requested     waiting on the team
 *   booked        the call exists and has not happened yet
 *   done          the call's time came with it accepted (or it was ended)
 *   fell_through  the call was cancelled, declined, deleted, or expired
 *                 unanswered — the request is NOT booked any more, whatever
 *                 its own status still says
 *
 * Null for a request that is declined or cancelled (history), or no request.
 */
export type InterviewStage = "requested" | "booked" | "done" | "fell_through";

export function interviewStage(
  request: {
    status: string;
    call: CallTiming | null;
  } | null,
  now: Date = new Date(),
): InterviewStage | null {
  if (!request) return null;
  if (request.status === "requested") return "requested";
  if (request.status !== "scheduled") return null;
  // `on delete set null` — a call deleted out from under the request.
  if (!request.call) return "fell_through";
  switch (callPhase(request.call, now)) {
    case "needs_answer":
    case "upcoming":
    case "joinable":
    case "live":
      return "booked";
    case "ended":
    case "completed":
      return "done";
    default:
      return "fell_through";
  }
}

/**
 * What the interview card should show on a given surface.
 *
 * `canAsk` is whether this student may file a NEW request right now (enrolled
 * and before kickoff); a request already in flight shows regardless, so a
 * student never loses track of one they filed. `hideDone` is for the dashboard
 * home, where a finished interview is not news — the calls page still shows it.
 */
export type InterviewCardState =
  | "hidden"
  | "compose"
  | "requested"
  | "booked"
  | "done";

export function interviewCardState(
  stage: InterviewStage | null,
  canAsk: boolean,
  opts: { hideDone?: boolean } = {},
): InterviewCardState {
  switch (stage) {
    case "requested":
      return "requested";
    case "booked":
      return "booked";
    case "done":
      return opts.hideDone ? "hidden" : "done";
    case "fell_through":
    case null:
      return canAsk ? "compose" : "hidden";
  }
}

/**
 * Every time the student proposed has already gone by.
 *
 * The team's queue flags these: booking one at the student's proposed time is
 * refused (it is in the past), so the row needs a new time or a decline, and
 * it should say so rather than failing on Save. False when the student
 * proposed nothing at all — there is nothing to have passed.
 */
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

/**
 * The time the booking form starts on: the student's first proposal that is
 * still ahead, or null (the caller falls back to "tomorrow, next round hour").
 * Never a past time — the server refuses those, so pre-filling one was a form
 * that failed on its most common click.
 */
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
 * May this person watch the call back?
 *
 * The two people who were on it, and admins — the same people the table's RLS
 * lets read the row, for the same safeguarding reason: in a programme of
 * minors someone accountable must be able to answer "what was said". Not
 * mentors or investors in general, even though they hold `calls.invite`; that
 * permission is for booking your OWN calls.
 */
export function canViewCallRecording(args: {
  viewerId: string;
  hostId: string;
  inviteeId: string;
  superAdmin: boolean;
}): boolean {
  return (
    args.superAdmin ||
    args.viewerId === args.hostId ||
    args.viewerId === args.inviteeId
  );
}

/**
 * Where a HOST's calls list lives. The room is shared by both people
 * (/dashboard/calls/<id>/live), but "back" for a mentor is /mentor/calls —
 * /dashboard/calls is the student's inbox and would show them an empty page.
 */
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
 * "Saturday, September 19, 2026 at 5:30 PM EDT".
 *
 * Email cannot know the reader's zone, and the invite used to print
 * `toUTCString()` — "Sat, 19 Sep 2026 21:30:00 GMT" — which for a student in
 * New York is Saturday EVENING, and for one in California is a time they have
 * to do arithmetic on. Eastern with the abbreviation named, like every other
 * human-facing date on the site (lib/promo.ts, lib/offer-format.ts); the zone
 * is spelled out so a reader elsewhere is not left guessing, and the .ics
 * attachment still carries the exact UTC instant for their calendar.
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
