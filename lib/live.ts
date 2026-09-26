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
 * How early someone may enter the room, and how long it stays open past the
 * end. The early window exists so a host can set up before an audience
 * arrives; the late window covers calls that run over.
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
 * This is the same gate the server must apply before minting a token. Doing it
 * here too is not duplication: this one decides what the UI shows, that one
 * decides what is actually allowed, and a token minted for an event three
 * weeks out is a live door standing open in the meantime.
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
export function inviteEndsAt(invite: CallInvite): string {
  return new Date(
    new Date(invite.startsAt).getTime() + invite.durationMinutes * MINUTE,
  ).toISOString();
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
