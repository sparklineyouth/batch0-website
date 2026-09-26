/**
 * Shared vocabulary for live video — webinars and 1:1 calls.
 *
 * Deliberately provider-agnostic. Nothing here knows about Daily (or LiveKit,
 * or whatever we land on): a room is a name and a URL, and a participant is
 * either allowed to broadcast or not. When the provider gets wired up, it
 * fills `roomName`/`roomUrl` in and mints a token off `LiveRole` — none of
 * these types change.
 *
 * Pure module, no imports, no `next/headers`. Safe from server components,
 * client components, and tests alike.
 */

/**
 * What a person may do inside a room.
 *
 * `host` gets camera, mic, and screen share. `viewer` watches and uses chat.
 * For a webinar that split is the whole feature (it maps to Daily's
 * `owner_only_broadcast`); for a 1:1 both people are hosts.
 */
export type LiveRole = "host" | "viewer";

/**
 * Where a live session lives.
 *
 *   external  A pasted link to someone else's Zoom. The original behaviour.
 *   hosted    A batch0 Live room — a real camera, in real time.
 *   premiere  A recording played on the schedule, handing over to a genuinely
 *             live Q&A at the end (migration 0084). Everything around the video
 *             — chat, questions, polls, attendance — is live throughout, which
 *             is what a premiere is FOR: it is a talk that has been rehearsed
 *             instead of improvised, not an audience that has been faked.
 *
 * `hosted` and `premiere` are both rooms batch0 owns, and almost every caller
 * that used to ask `=== "hosted"` means "is this ours". Use isHostedOnBatch0()
 * from lib/webinars.ts for that question — a bare `=== "hosted"` left over from
 * when there were two modes is a place a premiere silently behaves like an
 * external link.
 */
export type LiveMode = "external" | "hosted" | "premiere";

export type CallInviteStatus =
  | "invited"
  | "accepted"
  | "declined"
  | "cancelled"
  | "completed";

export type LiveRoom = {
  /** Provider-side room identifier. Null until a room has been created. */
  roomName: string | null;
  roomUrl: string | null;
};

// ---------------------------------------------------------------------------
// Audience privacy
// ---------------------------------------------------------------------------

/**
 * Whether someone in this role may see who else is in the room, and how many.
 *
 * Hosts yes, viewers never. This is a product requirement, not a layout
 * preference: a student watching a webinar must not be able to tell whether
 * they are one of three people or one of thirty. Turnout is the host's
 * business, and a visibly empty room changes how students behave in one.
 *
 * Kept here as a function of the role alone — no override parameter, no prop —
 * so there is exactly one place to read and no call site can opt out of it by
 * passing the wrong flag. `CallStage` derives every roster-shaped affordance
 * (the header count, the participants button, the people panel) from this.
 *
 * Two things this does NOT do on its own, both of which live at the provider
 * layer and are written up in docs/live-video.md:
 *
 *  1. The server must not send a viewer the roster in the first place. Hiding
 *     a list the client already holds is a CSS-deep guarantee.
 *  2. The video provider has its own participant APIs. With Daily that means
 *     minting viewer tokens with `hasPresence: false` so viewers are absent
 *     from every other client's participant list.
 */
export function canSeeRoster(role: LiveRole): boolean {
  return role === "host";
}

// ---------------------------------------------------------------------------
// Announced attendance
// ---------------------------------------------------------------------------

/**
 * Largest "shown attendees" figure an admin may set (mirrored by the DB CHECK
 * in migration 0071). Big enough for any real webinar, small enough that a
 * fat-fingered extra digit can't render a ten-character number into the header.
 */
export const MAX_DISPLAY_VIEWERS = 100_000;

/**
 * Sanitize an admin-entered "shown attendees" value into what we store and show.
 *
 * A webinar can carry an *announced* headcount — a number the admin chooses to
 * show the audience ("43 watching") instead of the true, hidden roster. It is a
 * deliberate exception to `canSeeRoster`: turnout is normally the host's
 * business, but a host may still want to project a figure. Empty, non-numeric,
 * or negative input means "don't announce anything" and becomes null — the room
 * then falls back to the private default (a viewer sees no count, a host sees
 * the real one). Anything larger than the cap is clamped, not rejected.
 *
 * Pure and shared so the form (to validate as it's typed), the server action
 * (the actual gate), and the room (which re-sanitizes on the way out, in case a
 * value was written straight into the row) all agree on what a valid figure is.
 */
export function normalizeDisplayViewers(
  input: number | string | null | undefined,
): number | null {
  if (input === null || input === undefined) return null;
  const trimmed = typeof input === "string" ? input.trim() : input;
  if (trimmed === "") return null;
  const n = Math.floor(Number(trimmed));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MAX_DISPLAY_VIEWERS);
}

/**
 * The headcount to show in a live room's header, and whether it is the
 * announced figure or the true roster.
 *
 * Precedence, and why:
 *  - An announced count (events.display_viewer_count), when set, wins for
 *    *everyone*. That is the whole point of the field — the audience sees the
 *    chosen number, and a host previewing the room sees exactly what the
 *    audience sees. A host still has the real roster elsewhere (the
 *    participants panel, the tiles they can actually see), and the caller can
 *    surface it alongside via the returned `announced` flag.
 *  - With no announced count, the privacy default holds: a host sees the real
 *    roster size, a viewer sees nothing.
 *
 * Returns null when there is nothing to show — a viewer in a room with no
 * announced count — so the caller renders no chip at all rather than a bare "0".
 * `realCount` may be null for backends that don't expose a client-side roster
 * (a Daily room manages its own participant list); such a room shows the
 * announced figure or nothing.
 */
export function headcountLabel({
  role,
  displayCount,
  realCount,
}: {
  role: LiveRole;
  displayCount: number | null;
  realCount: number | null;
}): { count: number; announced: boolean } | null {
  const announced = normalizeDisplayViewers(displayCount);
  if (announced !== null) return { count: announced, announced: true };
  if (canSeeRoster(role) && realCount !== null && realCount >= 0) {
    return { count: realCount, announced: false };
  }
  return null;
}

export type LiveEvent = {
  id: string;
  title: string;
  description: string | null;
  type: "demo_day" | "office_hours" | "workshop" | "webinar" | "other";
  startsAt: string;
  endsAt: string | null;
  /** Free text — "Virtual", or a physical address for in-person events. */
  location: string | null;
  liveMode: LiveMode;
  /** The pasted external link, used when `liveMode === "external"`. */
  externalUrl: string | null;
  recordingUrl: string | null;
  hostName: string | null;
  /**
   * Announced attendance shown in the live room in place of the hidden roster.
   * Null = the private default (see `headcountLabel`). Display only.
   */
  displayViewerCount: number | null;
  /**
   * When a host pressed End for everyone (`events.live_ended_at`), or null.
   *
   * Required rather than optional on purpose: every list that decides "Live
   * now / Join" has to have read it, because the clock alone keeps an ended
   * webinar looking live for up to fifty minutes. See `eventLiveStatus`.
   */
  liveEndedAt: string | null;
} & LiveRoom;

export type CallInvite = {
  id: string;
  hostName: string;
  hostRole: string;
  inviteeName: string;
  startsAt: string;
  durationMinutes: number;
  topic: string | null;
  status: CallInviteStatus;
  /**
   * When the row last changed (call_invites.updated_at, kept by the
   * touch_call_invites trigger). For a cancelled call that is when it was
   * cancelled — which is what tells a call cancelled mid-room, with recording
   * segments, from one cancelled days ahead (mayHaveCallRecording).
   */
  updatedAt?: string;
} & LiveRoom;

// ---------------------------------------------------------------------------
// Webinar Q&A
// ---------------------------------------------------------------------------

/**
 * A question a viewer asked during a hosted webinar (`webinar_questions`,
 * migration 0060).
 *
 * Questions live in our database, not in the video room's chat. A hidden
 * viewer (`hasPresence: false`) can read Daily's Prebuilt chat but not send to
 * it, so letting students ask through the room would mean un-hiding the
 * audience — the exact thing webinar mode exists to prevent. Routing questions
 * through here keeps the audience hidden and the questions ours: persisted,
 * moderatable, and scoped so a viewer only ever sees their own.
 */
export type QuestionStatus = "open" | "answered" | "dismissed";

export type WebinarQuestion = {
  id: string;
  eventId: string;
  askerId: string;
  /** Resolved server-side; a viewer never learns another viewer's name here. */
  askerName: string;
  body: string;
  status: QuestionStatus;
  createdAt: string;
};

/** Longest question we accept, matched by the DB check in migration 0060. */
export const MAX_QUESTION_LENGTH = 500;

/**
 * Clean up a submitted question, or reject it.
 *
 * Trims, collapses runs of whitespace (so a wall of newlines can't pad the
 * host's panel), and caps the length. Returns null for anything empty, which
 * the caller treats as "don't submit" rather than writing a blank row.
 *
 * Pure and exported so both the client (to disable the button) and the server
 * action (the actual gate) agree on what counts as a question, and so the
 * rule is unit-tested rather than implied.
 */
export function normalizeQuestion(input: string): string | null {
  const cleaned = input.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_QUESTION_LENGTH);
}

// ---------------------------------------------------------------------------
// Join window
// ---------------------------------------------------------------------------

/**
 * How early the AUDIENCE may enter the room, and how long it stays open past
 * the end. The late window covers calls that run over. Hosts have their own,
 * wider window (HOST_JOIN_OPENS_MINUTES_BEFORE / ROOM_HARD_CLOSE_MINUTES_AFTER
 * below) — see `roomAccess`.
 */
export const JOIN_OPENS_MINUTES_BEFORE = 15;
export const JOIN_CLOSES_MINUTES_AFTER = 30;

/** Assumed length of an event with no explicit end time. */
export const DEFAULT_EVENT_MINUTES = 60;

export type JoinState =
  /** Too early — show a countdown, not a button. */
  | "early"
  /** Open, but not started yet. */
  | "open"
  /** Scheduled time has passed and it's still within the window. */
  | "live"
  /** Window has closed. */
  | "ended";

const MINUTE = 60_000;

/**
 * Whether a session can be joined right now, and why not when it can't.
 *
 * The `now` parameter is injectable rather than read from the clock so this
 * stays a pure function — the tests pin it, and a server render can pass the
 * request time so every card on a page agrees with itself.
 *
 * This is the audience's window, and what the cards draw. The server's gate is
 * `roomAccess` below, which applies this same window to viewers and a wider
 * one to hosts. Doing it in both places is not duplication: this one decides
 * what the UI shows, that one decides what is actually allowed, and a token
 * minted for an event three weeks out is a live door standing open in the
 * meantime.
 */
export function joinState(
  startsAt: string | Date,
  endsAt: string | Date | null,
  now: Date = new Date(),
): JoinState {
  const start = new Date(startsAt).getTime();
  const end = endsAt
    ? new Date(endsAt).getTime()
    : start + DEFAULT_EVENT_MINUTES * MINUTE;
  const t = now.getTime();

  if (t < start - JOIN_OPENS_MINUTES_BEFORE * MINUTE) return "early";
  if (t > end + JOIN_CLOSES_MINUTES_AFTER * MINUTE) return "ended";
  return t < start ? "open" : "live";
}

export function canJoin(state: JoinState): boolean {
  return state === "open" || state === "live";
}

/** End time for an invite, derived from its duration. */
export function inviteEndsAt(
  invite: Pick<CallInvite, "startsAt" | "durationMinutes">,
): string {
  return new Date(
    new Date(invite.startsAt).getTime() + invite.durationMinutes * MINUTE,
  ).toISOString();
}

// ---------------------------------------------------------------------------
// Room access — who may be in a room right now, by role
// ---------------------------------------------------------------------------
//
// `joinState` above is the AUDIENCE's window, and for a long time it was
// applied to everybody: the page, the join action, the chat gate and the admin
// list all asked it, so an admin could not open the room more than fifteen
// minutes early to set up, and a webinar that ran past end+30 lost its host's
// End button mid-sentence (endLive threw Forbidden, the client swallowed it,
// and the webinar was never ended). `roomAccess` is the per-role answer every
// server gate now shares, so the page and the actions cannot disagree about
// whether someone is allowed in.

/**
 * How early a HOST (staff or guest speaker) may open the room.
 *
 * An hour, not the audience's fifteen minutes: checking the camera, loading
 * the deck and rehearsing a handover is the whole reason to arrive early, and
 * nobody is watching yet for a host to disturb.
 */
export const HOST_JOIN_OPENS_MINUTES_BEFORE = 60;

/**
 * The hard stop for any room, measured from the scheduled end.
 *
 * Hosts may stay (and End, and Reopen) until here, and a viewer's window is
 * extended up to here while a host is still genuinely present. Past it the
 * room is closed for everybody: a webinar still "running" three hours after
 * its scheduled end is a tab someone forgot, not a talk.
 */
export const ROOM_HARD_CLOSE_MINUTES_AFTER = 180;

/**
 * Where a person stands with respect to a room.
 *
 *   early   Before their window opens.
 *   open    Inside their window, before the scheduled start.
 *   live    Inside their window, at or after the scheduled start.
 *   ended   A host pressed End for everyone (`live_ended_at` is set). Only
 *           ever returned for a viewer — a host keeps their window so staff
 *           can reach the ended screen and Reopen.
 *   closed  Their window has passed.
 */
export type RoomAccess = "early" | "open" | "live" | "ended" | "closed";

/**
 * The answer a room gives a heartbeat, a join, or a status poll.
 *
 *   ok         Carry on.
 *   ended      The webinar was ended for everyone, or the 1:1 was completed.
 *              Terminal: tear down, show "ended".
 *   cancelled  The 1:1 was cancelled. Terminal.
 *   closed     The window has closed (the last host left and the grace ran
 *              out). The client acts on the SECOND consecutive answer, so one
 *              read at the boundary does not end anybody's session.
 *   revoked    The caller no longer has access (unenrolled, speaker row
 *              removed). Also acted on only when repeated.
 *   error      The server could not tell — a query failed. Never terminal: a
 *              database blip must not look like a revocation.
 *
 * Mirrored structurally by `nextStatusAction` in lib/live-signal.ts, which
 * decides what the client does with each answer.
 */
export type RoomStatus =
  | "ok"
  | "ended"
  | "cancelled"
  | "closed"
  | "revoked"
  | "error";

/**
 * The instants that bound one room, in epoch milliseconds.
 *
 * `ends_at` is nullable and defaults to DEFAULT_EVENT_MINUTES past the start,
 * the same rule `joinState` applies — computed here once so the page, the
 * gates and the tests all read the same numbers.
 */
export function roomWindow(
  startsAt: string | Date,
  endsAt: string | Date | null | undefined,
): {
  start: number;
  end: number;
  hostOpensAt: number;
  viewerOpensAt: number;
  viewerClosesAt: number;
  hardCloseAt: number;
} {
  const start = new Date(startsAt).getTime();
  const end = endsAt
    ? new Date(endsAt).getTime()
    : start + DEFAULT_EVENT_MINUTES * MINUTE;
  return {
    start,
    end,
    hostOpensAt: start - HOST_JOIN_OPENS_MINUTES_BEFORE * MINUTE,
    viewerOpensAt: start - JOIN_OPENS_MINUTES_BEFORE * MINUTE,
    viewerClosesAt: end + JOIN_CLOSES_MINUTES_AFTER * MINUTE,
    hardCloseAt: end + ROOM_HARD_CLOSE_MINUTES_AFTER * MINUTE,
  };
}

/**
 * Has this webinar's run begun? Its scheduled start has passed, or a host
 * handed a premiere over early ("Go live now" stamps `live_started_at`).
 *
 * End for everyone exists only from here on — `canEnd` in the room's actions,
 * which is what hides the room's End controls and what `endLive` enforces, and
 * the admin list's LiveControls. Before it the room is open to hosts for an
 * hour of setup, and an End pressed there (a camera check, then "End for
 * everyone" from the last-host prompt) ended the REAL webinar before it began:
 * every student arriving at the start was shown "This webinar has ended", the
 * event moved to Past, and a guest speaker who pressed it could not undo it.
 * Leave is the way out of a rehearsal.
 */
export function webinarHasBegun(
  startsAt: string | Date,
  liveStartedAt: string | Date | null | undefined,
  now: number = Date.now(),
): boolean {
  if (liveStartedAt) return true;
  return now >= new Date(startsAt).getTime();
}

/**
 * May this person be in this room right now?
 *
 * Two windows, because hosts and viewers need different things:
 *
 *   host    [start-60m, end+3h], whatever `liveEndedAt` says. A staff host has
 *           to be able to reach the ended screen to Reopen, and an overrunning
 *           webinar must never lose its End button.
 *   viewer  [start-15m, end+30m] as always, with two changes:
 *             - 'ended' as soon as `liveEndedAt` is set. An ended webinar hands
 *               out no more credentials and records no more attendance.
 *             - past end+30m the room stays open while a host is still
 *               genuinely present (`hostPresent`: a fresh host heartbeat) and
 *               nobody has ended it, up to the hard stop at end+3h. That is
 *               what lets a talk run over without its audience being cut off,
 *               while "the last host left and never pressed End" still closes
 *               on its own — there is deliberately no silent auto-stamp of
 *               `live_ended_at`, so a wifi drop can never end a webinar.
 *
 * `hostPresent` is only consulted past end+30m, so a caller may pass `false`
 * first and look presence up only when the answer comes back 'closed' — which
 * is exactly what lib/live-access.ts does, keeping the common case to zero
 * extra queries.
 */
export function roomAccess({
  startsAt,
  endsAt,
  liveEndedAt,
  isHost,
  hostPresent,
  now = new Date(),
}: {
  startsAt: string | Date;
  endsAt: string | Date | null | undefined;
  liveEndedAt: string | Date | null | undefined;
  isHost: boolean;
  hostPresent: boolean;
  now?: Date;
}): RoomAccess {
  const w = roomWindow(startsAt, endsAt);
  const t = now.getTime();

  if (isHost) {
    if (t < w.hostOpensAt) return "early";
    if (t > w.hardCloseAt) return "closed";
    return t < w.start ? "open" : "live";
  }

  if (liveEndedAt) return "ended";
  if (t < w.viewerOpensAt) return "early";
  if (t <= w.viewerClosesAt) return t < w.start ? "open" : "live";
  if (hostPresent && t <= w.hardCloseAt) return "live";
  return "closed";
}

/** Is this access answer one that lets someone into the room? */
export function roomIsOpen(access: RoomAccess): boolean {
  return access === "open" || access === "live";
}

/**
 * An event's state for a LIST — the dashboard, the admin webinars page, cards.
 *
 *   upcoming  Before the audience's window opens.
 *   open      Joinable, not started.
 *   live      Joinable, started.
 *   ended     A host pressed End for everyone. Shown as "Ended" with no Join,
 *             whatever the clock says — the bug this replaces kept an ended
 *             webinar under "Live now / Join now" for up to fifty minutes.
 *   past      The window closed without anyone pressing End.
 *
 * Deliberately knows nothing about host presence: a list has no business
 * querying heartbeats per card, so an overrunning webinar moves to Past at
 * end+30m here even though anyone already inside keeps their seat. The room
 * itself (via `roomAccess`) is the authority on who may still enter.
 */
export type EventLiveStatus = "upcoming" | "open" | "live" | "ended" | "past";

export function eventLiveStatus(
  {
    startsAt,
    endsAt,
    liveEndedAt,
  }: {
    startsAt: string | Date;
    endsAt: string | Date | null | undefined;
    liveEndedAt: string | Date | null | undefined;
  },
  now: Date = new Date(),
): EventLiveStatus {
  if (liveEndedAt) return "ended";
  const w = roomWindow(startsAt, endsAt);
  const t = now.getTime();
  if (t < w.viewerOpensAt) return "upcoming";
  if (t <= w.viewerClosesAt) return t < w.start ? "open" : "live";
  return "past";
}

/**
 * "in 3 minutes" / "2 hours ago" — a coarse relative label for join buttons
 * and countdowns.
 *
 * Uses Intl.RelativeTimeFormat so it localises for free. Callers should render
 * this on the client only (like `LocalTime` does): a server render would bake
 * in the build machine's idea of "now" and the label would be wrong by the
 * time anyone read it.
 */
export function relativeTime(
  target: string | Date,
  now: Date = new Date(),
): string {
  const diffMs = new Date(target).getTime() - now.getTime();
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 24 * 60 * MINUTE],
    ["hour", 60 * MINUTE],
    ["minute", MINUTE],
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(diffMs) >= ms) {
      return rtf.format(Math.round(diffMs / ms), unit);
    }
  }
  return rtf.format(Math.round(diffMs / 1000), "second");
}
