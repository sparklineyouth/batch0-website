/**
 * Shared vocabulary for live video — webinars and 1:1 calls.
 *
 * Pure module, no imports, no `next/headers`. Safe from server components,
 * client components, and tests alike.
 */

/**
 * What a person may do inside a room.
 *
 * `host` gets camera, mic, and screen share. `viewer` watches and uses chat.
 * For a webinar that split is the whole feature; for a 1:1 everyone on it is
 * a host.
 */
export type LiveRole = "host" | "viewer";

/**
 * Where a live session lives.
 *
 *   external  A pasted link to someone else's Zoom. The original behaviour.
 *   hosted    A batch0 Live room — a real camera, in real time.
 *   premiere  Retired (it was a recording handing over to a live Q&A,
 *             migration 0084). Existing rows run as ordinary hosted rooms, and
 *             the admin form no longer offers it.
 *
 * `hosted` and `premiere` are both rooms batch0 owns. Use isHostedOnBatch0()
 * from lib/webinars.ts for "is this ours" — a bare `=== "hosted"` is a place a
 * legacy premiere row silently behaves like an external link.
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
 * they are one of three people or one of thirty. The server enforces the same
 * rule at the source — a viewer is never sent the roster (lib/live-rooms.ts).
 */
export function canSeeRoster(role: LiveRole): boolean {
  return role === "host";
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
   * When a host pressed End for everyone (`events.live_ended_at`), or null.
   *
   * Required rather than optional on purpose: every list that decides "Live
   * now / Join" has to have read it, because the clock alone keeps an ended
   * webinar looking live for up to fifty minutes. See `eventLiveStatus`.
   */
  liveEndedAt: string | null;
  /**
   * When a host went live (`events.live_started_at`). A host who starts early
   * lets the audience in early, so a list that has read it offers Join before
   * the usual 15 minutes. Optional: a list that has not read it shows the
   * schedule's answer.
   */
  liveStartedAt?: string | null;
} & LiveRoom;

/** Someone on a call's staff side who did not send the invite (migration 0092). */
export type CallCohost = { id: string; name: string; role: string };

export type CallInvite = {
  id: string;
  /**
   * The host's and the student's profile ids. Every invite lib/calls.ts reads
   * carries both (toInvite); optional only so hand-built invites (the dev
   * preview, tests) need not invent them.
   *
   * For the "Add people" picker on a call that already exists: it must leave
   * out everyone on the call, and a co-host's id was always on the card while
   * the host and the student were only names. The server drops all three
   * anyway (normalizeCohostIds), but a picker offering the host to their own
   * call is a button that silently does nothing.
   */
  hostId?: string;
  inviteeId?: string;
  hostName: string;
  hostRole: string;
  inviteeName: string;
  /**
   * Everyone else on the staff side, in the order they were added. A "1:1" is
   * one student and any number of admins, mentors and investors; the host is
   * just the one who sent the invite. Empty on a database where 0092 hasn't
   * run (lib/calls.ts falls back), which is exactly a call with no co-hosts.
   */
  cohosts: CallCohost[];
  startsAt: string;
  durationMinutes: number;
  topic: string | null;
  status: CallInviteStatus;
  /**
   * When the row last changed (call_invites.updated_at, kept by the
   * touch_call_invites trigger). For a cancelled call that is when it was
   * cancelled — which is what tells a call cancelled mid-room, with a
   * recording, from one cancelled days ahead (callMayHaveRecording in
   * lib/call-recording.ts).
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
 * Questions live in our database: persisted, moderatable, and scoped so a
 * viewer only ever sees what their room's audience mode allows.
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
 * the end. Hosts have a wider window — see `roomAccess` and `callRoomAccess`.
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

/** End time for an invite, derived from its duration. */
export function inviteEndsAt(
  invite: Pick<CallInvite, "startsAt" | "durationMinutes">,
): string {
  return new Date(
    new Date(invite.startsAt).getTime() + invite.durationMinutes * MINUTE,
  ).toISOString();
}

// ---------------------------------------------------------------------------
// Who is on a call
// ---------------------------------------------------------------------------
//
// Since migration 0092 a call is one student and a STAFF SIDE: the host (who
// sent the invite) plus any co-hosts. Every gate that used to ask "host or
// invitee?" — the join page, the room's credentials, End call, Cancel, the
// recording, the calendar file — asks these instead, so a co-host can never be
// let in by one surface and turned away by the next.

/** The raw ids a gate decides on. `getInvite` and `resolveCallAccess` carry them. */
export type CallParties = {
  hostId: string;
  inviteeId: string;
  cohosts: readonly { id: string }[];
};

/** Host first, then co-hosts: everyone who may run the call. Never the student. */
export function callStaffIds(call: CallParties): string[] {
  return [call.hostId, ...call.cohosts.map((c) => c.id)];
}

/** Is this person on the staff side of the call — its host or a co-host? */
export function isStaffOnCall(call: CallParties, userId: string): boolean {
  return !!userId && callStaffIds(call).includes(userId);
}

/**
 * Is this person on the call at all? The join, calendar and recording gate.
 * An admin who is NOT on it gets no — the safeguarding list is read-only.
 */
export function isOnCall(call: CallParties, userId: string): boolean {
  return !!userId && (call.inviteeId === userId || isStaffOnCall(call, userId));
}

/**
 * Is `peerId` on the OTHER side of the call from `selfId` — the person whose
 * presence means the conversation has actually happened?
 *
 * For anyone on the staff side that is the student, and only the student: a
 * co-host being in the room with you is the team waiting, not the call
 * taking place. For the student it is anyone on the staff side. Before
 * co-hosts the only other person in a call room was always the other side, so
 * "someone else is here" and "the other side is here" were the same question;
 * End call's gate (broadcast-room) asks this one.
 *
 * `staffIds` is the call's staff side (callStaffIds).
 */
export function isCallCounterpart(
  staffIds: readonly string[],
  selfId: string,
  peerId: string,
): boolean {
  if (!peerId || peerId === selfId) return false;
  const selfIsStaff = staffIds.includes(selfId);
  const peerIsStaff = staffIds.includes(peerId);
  return selfIsStaff ? !peerIsStaff : peerIsStaff;
}

/**
 * The most people a call's staff side may add besides its host. An abuse
 * guard more than a product rule: a call is a peer-to-peer mesh — everyone's
 * video goes to everyone — so it runs best well under this. The picker stops
 * at it and resolveCohosts refuses past it.
 */
export const MAX_CALL_COHOSTS = 20;

/**
 * The co-host ids a host asked for, cleaned: deduplicated, and without the
 * host or the student. Both of those are already on the call, so naming them
 * is a noisy selection rather than an error — and a host listed as their own
 * co-host would be dialled twice by the room.
 */
export function normalizeCohostIds(
  ids: readonly unknown[] | null | undefined,
  exclude: { hostId: string; inviteeId: string },
): string[] {
  const out: string[] = [];
  for (const id of ids ?? []) {
    if (typeof id !== "string" || !id) continue;
    if (id === exclude.hostId || id === exclude.inviteeId) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** "Ana", "Ana and Ben", "Ana, Ben and Cy". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The staff side of a call by name: the host first, then co-hosts. */
export function staffNames(
  invite: Pick<CallInvite, "hostName" | "cohosts">,
): string[] {
  return [invite.hostName, ...invite.cohosts.map((c) => c.name)];
}

// ---------------------------------------------------------------------------
// Room access — who may be in a room right now, by role
// ---------------------------------------------------------------------------
//
// `joinState` above is the AUDIENCE's window and what cards draw. `roomAccess`
// (webinars) and `callRoomAccess` (1:1s) are the per-role answers every server
// gate shares, so the page and the actions cannot disagree about who is in.

/**
 * The hard stop for any room, measured from the scheduled end. Past it the
 * room is closed for everybody: a session still "running" three hours after
 * its scheduled end is a tab someone forgot, not a talk.
 */
export const ROOM_HARD_CLOSE_MINUTES_AFTER = 180;

/** How early the staff side of a 1:1 may open its room (the student: 15). */
export const CALL_STAFF_OPENS_MINUTES_BEFORE = 60;

/**
 * How early a host in a webinar's room counts as GOING LIVE: stamping
 * `live_started_at`, which lets the audience in and makes End available.
 *
 * Hosts may open the room at any time, but before this they are rehearsing.
 * A camera check on Tuesday for a Thursday webinar must not open the room to
 * students for two days, nor offer an End that would cancel the real thing.
 */
export const GO_LIVE_OPENS_MINUTES_BEFORE = 60;

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
 *   closed     The window has closed. The client acts on the SECOND
 *              consecutive answer, so one read at the boundary does not end
 *              anybody's session.
 *   revoked    The caller no longer has access. Also acted on only when
 *              repeated.
 *   error      The server could not tell — a query failed. Never terminal: a
 *              database blip must not look like a revocation.
 *
 * Mirrored structurally by `nextStatusAction` in lib/live-signal.ts.
 */
export type RoomStatus =
  | "ok"
  | "ended"
  | "cancelled"
  | "closed"
  | "revoked"
  | "error";

/**
 * The instants that bound one room, in epoch milliseconds. `ends_at` is
 * nullable and defaults to DEFAULT_EVENT_MINUTES past the start, the same rule
 * `joinState` applies.
 */
export function roomWindow(
  startsAt: string | Date,
  endsAt: string | Date | null | undefined,
): {
  start: number;
  end: number;
  goLiveOpensAt: number;
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
    goLiveOpensAt: start - GO_LIVE_OPENS_MINUTES_BEFORE * MINUTE,
    viewerOpensAt: start - JOIN_OPENS_MINUTES_BEFORE * MINUTE,
    viewerClosesAt: end + JOIN_CLOSES_MINUTES_AFTER * MINUTE,
    hardCloseAt: end + ROOM_HARD_CLOSE_MINUTES_AFTER * MINUTE,
  };
}

/**
 * Has this webinar's run begun? A host went live (`live_started_at`, stamped
 * by a host in the room from start − GO_LIVE_OPENS_MINUTES_BEFORE on — see
 * shouldStampLiveStart), or the scheduled start has passed. End for everyone
 * exists only from here on; before it, a rehearsal's way out is Leave.
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
 * Should a host in the room (joining, or heartbeating) stamp
 * `live_started_at` now?
 *
 * Only inside the go-live window — from start − GO_LIVE_OPENS_MINUTES_BEFORE
 * to the hard stop — and only once: never over an existing stamp, never after
 * End. A host who opened the room earlier is rehearsing, and their first
 * heartbeat inside the window is the start. A legacy premiere row is no
 * exception: premiere is retired and those rows run as hosted rooms.
 */
export function shouldStampLiveStart({
  startsAt,
  endsAt,
  liveStartedAt,
  liveEndedAt,
  now = new Date(),
}: {
  startsAt: string | Date;
  endsAt: string | Date | null | undefined;
  liveStartedAt: string | Date | null | undefined;
  liveEndedAt: string | Date | null | undefined;
  now?: Date;
}): boolean {
  if (liveStartedAt || liveEndedAt) return false;
  const w = roomWindow(startsAt, endsAt);
  const t = now.getTime();
  return t >= w.goLiveOpensAt && t <= w.hardCloseAt;
}

/**
 * May this person be in this webinar's room right now?
 *
 *   host    any time up to the hard stop (end+3h), whatever `liveEndedAt`
 *           says: staff set up whenever they like, reach the ended screen to
 *           Reopen, and an overrunning webinar never loses its End button.
 *           Before the go-live window (start-60m) that is a rehearsal: it
 *           stamps nothing and lets nobody else in (shouldStampLiveStart).
 *   viewer  'ended' once `liveEndedAt` is set. Otherwise start-15m to end+30m,
 *           with two widenings:
 *             - a host went live early (`liveStartedAt`, at most an hour
 *               before the start): in now — the audience follows the host in;
 *             - past end+30m while a host is still present (`hostPresent`),
 *               up to the hard stop. There is no silent auto-stamp of
 *               `live_ended_at`, so a wifi drop can never end a webinar.
 *
 * `hostPresent` is only consulted past end+30m, so a caller may pass `false`
 * first and look presence up only when the answer comes back 'closed'.
 */
export function roomAccess({
  startsAt,
  endsAt,
  liveStartedAt = null,
  liveEndedAt,
  isHost,
  hostPresent,
  now = new Date(),
}: {
  startsAt: string | Date;
  endsAt: string | Date | null | undefined;
  liveStartedAt?: string | Date | null;
  liveEndedAt: string | Date | null | undefined;
  isHost: boolean;
  hostPresent: boolean;
  now?: Date;
}): RoomAccess {
  const w = roomWindow(startsAt, endsAt);
  const t = now.getTime();
  if (t > w.hardCloseAt) return "closed";
  if (isHost) return t < w.start ? "open" : "live";
  if (liveEndedAt) return "ended";
  if (!liveStartedAt && t < w.viewerOpensAt) return "early";
  if (t <= w.viewerClosesAt || hostPresent) return t < w.start ? "open" : "live";
  return "closed";
}

/**
 * May the caller End this webinar for everyone right now?
 *
 * Only once it has begun (webinarHasBegun), before the hard stop, and not
 * after it already ended. Staff always; a guest speaker only while no staff
 * host is present; a viewer never.
 */
export function mayEndWebinar({
  isStaff,
  isSpeaker,
  staffPresent,
  startsAt,
  endsAt,
  liveStartedAt,
  liveEndedAt,
  now = new Date(),
}: {
  isStaff: boolean;
  isSpeaker: boolean;
  staffPresent: boolean;
  startsAt: string | Date;
  endsAt: string | Date | null | undefined;
  liveStartedAt: string | Date | null | undefined;
  liveEndedAt: string | Date | null | undefined;
  now?: Date;
}): boolean {
  if (liveEndedAt) return false;
  if (now.getTime() > roomWindow(startsAt, endsAt).hardCloseAt) return false;
  if (!webinarHasBegun(startsAt, liveStartedAt, now.getTime())) return false;
  if (isStaff) return true;
  return isSpeaker && !staffPresent;
}

/**
 * Should a host who is joining (or heartbeating) take the primary seat — the
 * stage everyone sees when nobody is presenting?
 *
 * Yes when nobody holds it, or the holder is not present any more (left, or
 * no heartbeat for PEER_TIMEOUT_MS). Never when presence cannot be read
 * (`present` null): a guess would steal the stage from a host who is there.
 */
export function shouldClaimPrimary({
  current,
  selfId,
  present,
}: {
  current: string | null;
  selfId: string;
  present: readonly string[] | null;
}): boolean {
  if (!current) return true;
  if (current === selfId || present === null) return false;
  return !present.includes(current);
}

/**
 * Where a person stands with respect to a 1:1's room.
 *
 * An invite nobody has answered yet is joinable exactly like an accepted one
 * (the student can still Decline beforehand); declined, cancelled and
 * completed are not. The staff side may enter an hour early, the student 15
 * minutes early. The room then stays open until End call, a cancel, or the
 * hard stop (end+3h) — a call that runs long is never cut off mid-sentence.
 */
export type CallRoomAccess =
  | "early"
  | "open"
  | "live"
  | "closed"
  | "completed"
  | "cancelled"
  | "declined";

export function callRoomAccess({
  status,
  startsAt,
  durationMinutes,
  isStaff,
  now = new Date(),
}: {
  status: string;
  startsAt: string | Date;
  durationMinutes: number;
  isStaff: boolean;
  now?: Date;
}): CallRoomAccess {
  if (status === "completed" || status === "cancelled" || status === "declined") {
    return status;
  }
  // An unknown status is never a door to open.
  if (status !== "invited" && status !== "accepted") return "cancelled";
  const start = new Date(startsAt).getTime();
  const end = start + durationMinutes * MINUTE;
  const opens =
    start -
    (isStaff ? CALL_STAFF_OPENS_MINUTES_BEFORE : JOIN_OPENS_MINUTES_BEFORE) *
      MINUTE;
  const t = now.getTime();
  if (t < opens) return "early";
  if (t > end + ROOM_HARD_CLOSE_MINUTES_AFTER * MINUTE) return "closed";
  return t < start ? "open" : "live";
}

/** May someone on this 1:1 End call now? From the start, while it is open. */
export function mayEndCall({
  status,
  startsAt,
  now = new Date(),
}: {
  status: string;
  startsAt: string | Date;
  now?: Date;
}): boolean {
  if (status !== "invited" && status !== "accepted") return false;
  return now.getTime() >= new Date(startsAt).getTime();
}

// ---------------------------------------------------------------------------
// Server truth about a room, carried on every join and heartbeat answer
// ---------------------------------------------------------------------------

/** The recording running in a room right now (recording_sessions, 0095). */
export type RoomRecording = {
  sessionId: string;
  byUserId: string;
  byName: string;
  startedAt: string;
};

export type LiveRoomState = {
  /** Webinar primary host (pinned for everyone); null for calls / unknown. */
  primaryId: string | null;
  /** Webinar: when a host first went live. Null for calls. */
  liveStartedAt: string | null;
  /** Webinar: End for everyone. Null for calls. */
  liveEndedAt: string | null;
  /** May THIS user End for everyone / End call right now? */
  canEnd: boolean;
  recording: RoomRecording | null;
};

/** Same server truth? Lets the engine skip a re-render on an unchanged heartbeat. */
export function sameRoomState(
  a: LiveRoomState | null,
  b: LiveRoomState | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ra = a.recording;
  const rb = b.recording;
  return (
    a.primaryId === b.primaryId &&
    a.liveStartedAt === b.liveStartedAt &&
    a.liveEndedAt === b.liveEndedAt &&
    a.canEnd === b.canEnd &&
    (ra === rb ||
      (!!ra &&
        !!rb &&
        ra.sessionId === rb.sessionId &&
        ra.byUserId === rb.byUserId &&
        ra.byName === rb.byName &&
        ra.startedAt === rb.startedAt))
  );
}

/** Is this access answer one that lets someone into the room? */
export function roomIsOpen(access: RoomAccess): boolean {
  return access === "open" || access === "live";
}

/**
 * An event's state for a LIST — the dashboard, the admin webinars page, cards.
 *
 *   upcoming  Before the audience's window opens, and no host has gone live.
 *   open      Joinable, not started — inside the audience's window, or
 *             earlier because a host went live early (`liveStartedAt`), the
 *             same widening `roomAccess` gives viewers.
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
    liveStartedAt,
    liveEndedAt,
  }: {
    startsAt: string | Date;
    endsAt: string | Date | null | undefined;
    liveStartedAt?: string | Date | null;
    liveEndedAt: string | Date | null | undefined;
  },
  now: Date = new Date(),
): EventLiveStatus {
  if (liveEndedAt) return "ended";
  const w = roomWindow(startsAt, endsAt);
  const t = now.getTime();
  if (t < w.viewerOpensAt) return liveStartedAt ? "open" : "upcoming";
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
