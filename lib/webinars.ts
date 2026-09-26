/**
 * Shared vocabulary for webinars — the rules, with no I/O.
 *
 * Sits beside lib/live.ts and follows the same discipline: no imports, no
 * `next/headers`, no browser globals, no `server-only`. Every rule in here is
 * needed on both sides of the wire — the server enforces it, the client draws
 * it, and a test pins it — so it has to be a module both can hold.
 *
 * That is not a style preference. The audience-privacy rules in this subsystem
 * are one boolean each, and the ones that live only in a React component are
 * the ones that get quietly undone. Anything here can be asserted in
 * lib/webinars.test.ts under `npm test`, with no transpile step, because Node
 * strips the types natively — which is exactly why this file stays import-free.
 */

// ---------------------------------------------------------------------------
// Audience mode
// ---------------------------------------------------------------------------

/**
 * May the audience see itself?
 *
 * The rest of this subsystem answers "no" as a constant: `canSeeRoster()` in
 * lib/live.ts takes a role and nothing else, migration 0076 makes the hiding
 * structural by never disclosing one viewer to another, and 0060 kept Q&A off
 * the video provider's chat because a hidden viewer could read it but not send.
 *
 * Live chat cannot exist under that constant. Chat IS the audience seeing
 * itself — a name on a message is a disclosure that the person is in the room,
 * and no amount of care in the UI changes that. So instead of weakening a
 * guarantee the whole system is built on, the guarantee becomes a per-event
 * setting an admin chooses, defaulting to exactly what happens today.
 *
 *   private    A viewer sees only their own questions, and there is no chat.
 *              Nothing on the wire tells one student that another exists. This
 *              is the default, and it is what every event created before
 *              migration 0084 does.
 *
 *   moderated  Viewers write; a host decides what the room sees. An unapproved
 *              message reaches the hosts and nobody else — enforced in RLS, not
 *              just here. The right setting for a public webinar in a program
 *              with minors: a live channel where nothing reaches the audience
 *              that a human has not read.
 *
 *   open       Ordinary live chat. Everyone sees every message and who wrote
 *              it. For rooms where the audience is meant to know each other —
 *              a cohort call, not a public intake webinar.
 *
 * Deliberately ONE knob rather than three (chat on/off, questions
 * public/private, upvotes on/off). All three are the same question, and
 * splitting them would let an admin pick a combination that hides through one
 * surface while leaking through another.
 */
export type AudienceMode = "private" | "moderated" | "open";

export const AUDIENCE_MODES: readonly AudienceMode[] = [
  "private",
  "moderated",
  "open",
] as const;

/**
 * Is there a shared, audience-visible channel at all?
 *
 * The single predicate every surface reads: whether to render a chat column,
 * whether a question may carry an upvote button, whether another student's
 * name may ever appear beside a message. False in `private`, and a call site
 * that forgets to ask gets the safe answer by construction — because in
 * `private` mode the server never sends the data in the first place.
 */
export function audienceCanSeeEachOther(mode: AudienceMode): boolean {
  return mode === "moderated" || mode === "open";
}

/**
 * Must a host let this through before the room sees it?
 *
 * Note what this is NOT: a check on whether the author is staff. A host's own
 * message is approved on insert by the action, which is a separate decision
 * made where the author is known. This function answers only "does this room
 * hold messages for review", so there is one place to change if a fourth mode
 * ever appears.
 */
export function messagesNeedApproval(mode: AudienceMode): boolean {
  return mode === "moderated";
}

/** Coerce whatever is in the column into a mode. Unknown values fail closed. */
export function normalizeAudienceMode(value: unknown): AudienceMode {
  return value === "moderated" || value === "open"
    ? value
    : // Anything unrecognised — null from a row written before 0084, a typo, a
      // future mode this build does not know about — becomes the private
      // default. Failing closed here means a deploy that is behind the database
      // shows a webinar with no chat, rather than one with unmoderated chat.
      "private";
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** Longest chat message we accept. Mirrors the CHECK in migration 0084. */
export const MAX_CHAT_LENGTH = 1000;

/**
 * How many messages one person may send in a ten-second window.
 *
 * Mirrors the count in the `webinar_messages insert` policy — keep the two
 * numbers in step. A per-window limit rather than a per-event total, because
 * chat is not Q&A: a total cap is either low enough to cut off a talkative
 * student halfway through an hour, or high enough to be no limit at all.
 */
export const CHAT_BURST_LIMIT = 5;
export const CHAT_BURST_WINDOW_MS = 10_000;

/**
 * Clean a chat message, or reject it.
 *
 * Unlike `normalizeQuestion` in lib/live.ts, this preserves single newlines:
 * a question is one sentence for a queue, and a chat message is speech, where
 * a two-line answer is normal. Runs of three or more newlines collapse to two,
 * so nobody can scroll the room with a wall of blanks, and trailing whitespace
 * on each line goes so that a paste out of a document does not arrive ragged.
 *
 * Returns null for anything empty, which every caller treats as "don't send"
 * rather than writing a blank row.
 */
export function normalizeChatMessage(input: string): string | null {
  const cleaned = input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_CHAT_LENGTH);
}

export type ChatMessage = {
  id: string;
  eventId: string;
  authorId: string;
  /** Resolved server-side. "You" for the reader's own messages. */
  authorName: string;
  body: string;
  /** Was the author staff or a guest speaker when they sent it? */
  isHost: boolean;
  /** Null while waiting on a host in `moderated` mode. */
  approvedAt: string | null;
  pinned: boolean;
  createdAt: string;
};

/**
 * Is this message visible to the audience right now?
 *
 * The server already filters — a viewer is never sent a pending message, which
 * is the guarantee that actually holds. This is the client's copy, used to
 * decide how to draw a message the reader can legitimately see: their OWN
 * pending message, which they must keep seeing (a student whose message
 * vanished on send would reasonably conclude the room is broken and send it
 * again), drawn as "waiting to be shown" rather than as live.
 */
export function chatMessageIsLive(
  message: Pick<ChatMessage, "approvedAt">,
  mode: AudienceMode,
): boolean {
  if (!audienceCanSeeEachOther(mode)) return false;
  return message.approvedAt !== null;
}

// ---------------------------------------------------------------------------
// Files attached to an event
// ---------------------------------------------------------------------------

export type AssetKind = "deck" | "handout" | "premiere" | "recording";

export type EventAsset = {
  id: string;
  eventId: string;
  kind: AssetKind;
  storagePath: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  sortOrder: number;
  createdAt: string;
};

/**
 * What the deck picker accepts.
 *
 * pptx and pdf are what the product promises; `application/vnd.ms-powerpoint`
 * is legacy .ppt, and keyed .key files are not included because nothing
 * downstream can open one. The list is advisory in the browser (an `accept`
 * attribute is a filter on a file dialog, not a gate) and re-checked in
 * `assetKindForFile` on the server, which is the part that binds.
 */
export const DECK_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
] as const;

export const DECK_EXTENSIONS = [".pdf", ".pptx", ".ppt"] as const;

/**
 * Longest premiere or recording segment we will accept, in bytes.
 *
 * Matches the `webinar-media` bucket's `file_size_limit` in migration 0084.
 * Stated here too so the form can refuse a 4 GB file before spending ten
 * minutes uploading it to a bucket that will reject it at the end — the
 * bucket's copy is the one that binds, this one is the one that is kind.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Is this file a usable deck?
 *
 * Checks the extension as well as the MIME type, because browsers disagree
 * about pptx: Chrome sends the long
 * `vnd.openxmlformats-officedocument.presentationml.presentation`, some Windows
 * configurations send `application/octet-stream`, and a file dragged out of a
 * zip can arrive with an empty type. Rejecting on MIME alone turns "upload your
 * deck" into a coin flip, so the extension is enough on its own.
 */
export function isDeckFile(filename: string, mimeType?: string | null): boolean {
  const lower = filename.toLowerCase();
  if (DECK_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  return !!mimeType && (DECK_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Human size for a file card. Deliberately coarse — nobody needs the bytes. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * How much of a webinar goes into one recording segment.
 *
 * The recorder writes a self-contained file this long and uploads it while the
 * webinar is still running, rather than holding an hour in the tab and pushing
 * it all at the end. That trade is the whole design:
 *
 *   - memory stays bounded by one segment instead of growing all hour;
 *   - the upload finishes seconds after the talk does, not ten minutes later
 *     while the host is trying to close the laptop;
 *   - a crashed tab or a dropped connection costs the segment in flight,
 *     not the hour behind it.
 *
 * The cost is a seam every five minutes, because a `MediaRecorder` has to be
 * stopped and restarted for each file to carry its own header and be playable
 * on its own. That seam is tens of milliseconds and the player preloads across
 * it. Five minutes is the number that makes the seam rare (about eleven in an
 * hour) while keeping each upload small enough to retry cheaply.
 */
export const RECORDING_SEGMENT_SECONDS = 300;

/**
 * Video bitrate for the recording, in bits per second.
 *
 * 1.2 Mbps is a deliberate compromise. Higher looks better and puts an hour of
 * webinar past a gigabyte, which is a lot to ask of a host's upstream *while
 * they are broadcasting on the same connection* — the recording competes with
 * the thing it is recording. At 1.2 Mbps a five-minute segment is about 45 MB
 * and an hour is about 540 MB, and screen-shared slides (which is most of what
 * a webinar shows, and which compresses very well) look clean.
 */
export const RECORDING_VIDEO_BITRATE = 1_200_000;
export const RECORDING_AUDIO_BITRATE = 96_000;

/** Frame rate the composed canvas is captured at. */
export const RECORDING_FPS = 24;

// ---------------------------------------------------------------------------
// Guest speakers
// ---------------------------------------------------------------------------

export type EventSpeaker = {
  id: string;
  eventId: string;
  /** Null until they claim the slot. A card with no access. */
  userId: string | null;
  name: string;
  title: string | null;
  bio: string | null;
  photoUrl: string | null;
  linkUrl: string | null;
  /** Only ever sent to staff — see the select lists in lib/webinar-data.ts. */
  email?: string | null;
  sortOrder: number;
};

/**
 * May this person broadcast in this room?
 *
 * The rule the live role is derived from. `events.manage` is the staff grant
 * (admins hold it through the `*` wildcard, and so does any custom role an
 * admin ticks it on); a CLAIMED speaker row is the per-event grant that exists
 * so a guest does not have to be handed the admin panel for forty minutes of
 * talking. An unclaimed row (`userId` null) grants nobody anything.
 *
 * It is called in exactly one place — `resolveEventAccess` in
 * lib/live-access.ts — and every consumer (the page, joinRoom/announce/leave,
 * the room gates, the upload gate, the Q&A actions) reads the answer from
 * there. That single call site is what actually keeps them from drifting; this
 * function is where the rule is written down and tested.
 *
 * Takes ids rather than objects so the server can call it with whatever it has
 * already fetched, and so it has nothing to import.
 */
export function canBroadcast({
  hasEventsManage,
  userId,
  speakers,
}: {
  hasEventsManage: boolean;
  userId: string | null;
  speakers: readonly { userId: string | null }[];
}): boolean {
  if (hasEventsManage) return true;
  if (!userId) return false;
  return speakers.some((s) => s.userId === userId);
}

/**
 * May this host end the webinar for EVERYONE?
 *
 * Staff always. A guest speaker only when no staff host is present in the room
 * — which keeps a guest-only webinar closable (otherwise the last speaker to
 * finish could only Leave, and the audience would sit on "the host stepped
 * away" until the window ran out) without letting a guest end a room an admin
 * is running. A founder who presses "End" thinking it ends their segment is
 * exactly the case this refuses; their normal exit is Leave.
 *
 * `staffPresent` comes from the attendance table (fresh host rows that belong
 * to non-speakers). When that table cannot be read the server passes `false`,
 * i.e. the rule fails OPEN for speakers: ending is reversible by staff and is
 * not a privacy risk, while failing closed would strand guest-only webinars.
 */
export function canEndForEveryone({
  isStaff,
  isSpeaker,
  staffPresent,
}: {
  isStaff: boolean;
  isSpeaker: boolean;
  staffPresent: boolean;
}): boolean {
  if (isStaff) return true;
  if (isSpeaker) return !staffPresent;
  return false;
}

/**
 * How long the host who uploaded the latest recording segment keeps the
 * recorder while present, in milliseconds.
 *
 * One segment's length plus two minutes. A segment is registered only when it
 * finishes (every RECORDING_SEGMENT_SECONDS), so a window shorter than a
 * segment would drop the stickiness between every pair of uploads and let the
 * pick flap to another host mid-recording. The extra two minutes cover the
 * upload itself.
 */
export const RECORDER_STICKY_MS = RECORDING_SEGMENT_SECONDS * 1000 + 2 * 60_000;

/**
 * Which host records this webinar right now. Exactly one, or nobody.
 *
 * The server calls this on every host heartbeat and tells each host whether
 * they are it, which is what stops two admins in the same room from each
 * running a recorder and interleaving each other's segments. (Registration
 * no longer lets one overwrite the other — it appends on a clash — but two
 * cameras cut together in five-minute pieces is not a recording.)
 *
 *   1. Sticky: whoever registered the most recent REAL segment (see
 *      stickySegment — a flush from a recorder that just lost the pick does
 *      not count) within RECORDER_STICKY_MS keeps recording while they are
 *      still present. A handover mid-talk costs a seam and risks a gap; not
 *      handing over when nothing is wrong costs nothing.
 *   2. Otherwise the earliest-joined present staff host. Deterministic, so
 *      every host's heartbeat computes the same answer.
 *
 * Guest speakers never record: the recording is the program's record of a
 * room that may contain minors, and it is owned by the staff accountable for
 * it. (A speaker's tab would also be uploading an hour of video over the same
 * connection it is broadcasting on.)
 */
export function pickRecorder({
  presentHosts,
  lastSegment,
  now = new Date(),
  stickyMs = RECORDER_STICKY_MS,
}: {
  presentHosts: readonly {
    userId: string;
    joinedAt: string | Date;
    isSpeaker: boolean;
  }[];
  lastSegment: { userId: string | null; at: string | Date } | null;
  now?: Date;
  stickyMs?: number;
}): string | null {
  const staff = presentHosts.filter((h) => !h.isSpeaker);
  if (staff.length === 0) return null;

  if (lastSegment?.userId) {
    const fresh = now.getTime() - new Date(lastSegment.at).getTime() <= stickyMs;
    if (fresh && staff.some((h) => h.userId === lastSegment.userId)) {
      return lastSegment.userId;
    }
  }

  // Earliest joined wins; ties broken by id so two hosts whose rows share a
  // timestamp still agree on one answer.
  const sorted = [...staff].sort((a, b) => {
    const d = new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
    return d !== 0 ? d : a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  return sorted[0].userId;
}

/**
 * The shortest segment that counts for stickiness, in seconds.
 *
 * A recorder that loses the pick stops, and stopping flushes whatever it had
 * — usually one heartbeat's worth (about 12s) of a recording it should never
 * have started. Keyed on "the most recent segment" alone, that flush made the
 * loser sticky, so the NEXT heartbeat handed the recording back to it and
 * stopped the real recorder, whose own flush then took it back again: the
 * pick could ping-pong for as long as the heartbeats stayed in phase, cutting
 * the recording into twelve-second pieces from two cameras. A minute is far
 * above any such flush and far below a real five-minute segment.
 */
export const RECORDER_STICKY_MIN_SECONDS = 60;

/**
 * Which registered segment the sticky rule should key on: the most recently
 * registered one long enough to be real recording (RECORDER_STICKY_MIN_SECONDS),
 * or null. Pass the last few segments by registration time; feed the answer to
 * pickRecorder as `lastSegment`.
 */
export function stickySegment(
  segments: readonly {
    userId: string | null;
    at: string | Date;
    seconds: number | null;
  }[],
  minSeconds: number = RECORDER_STICKY_MIN_SECONDS,
): { userId: string | null; at: string | Date } | null {
  let best: { userId: string | null; at: string | Date } | null = null;
  let bestAt = -Infinity;
  for (const s of segments) {
    if ((s.seconds ?? 0) < minSeconds) continue;
    const t = new Date(s.at).getTime();
    if (!Number.isFinite(t) || t <= bestAt) continue;
    best = { userId: s.userId, at: s.at };
    bestAt = t;
  }
  return best;
}

/**
 * Host presence could not be read at all: should this staff host record anyway?
 *
 * Yes, unless someone ELSE registered a real segment within the sticky window
 * — then they are recording, and a second recorder would only interleave with
 * them. This used to be an unconditional yes ("a duplicate is recoverable, a
 * webinar nobody recorded is not"), so one failed attendance read turned every
 * staff host in the room into a recorder for a heartbeat, each numbering
 * segments from the same seed as the real one.
 */
export function mayRecordBlind({
  userId,
  lastSegment,
  now = new Date(),
  stickyMs = RECORDER_STICKY_MS,
}: {
  userId: string;
  lastSegment: { userId: string | null; at: string | Date } | null;
  now?: Date;
  stickyMs?: number;
}): boolean {
  if (!lastSegment?.userId || lastSegment.userId === userId) return true;
  return now.getTime() - new Date(lastSegment.at).getTime() > stickyMs;
}

// ---------------------------------------------------------------------------
// Premieres
// ---------------------------------------------------------------------------

/**
 * Where a premiere is right now.
 *
 *   waiting  Before the start. The room shows a countdown.
 *   playing  The recording is running. Every viewer is positioned at the same
 *            offset, computed from the wall clock, so someone arriving twenty
 *            minutes late joins twenty minutes in — which is what makes it
 *            read as live rather than as a video that started when they
 *            pressed play.
 *   live     A host is genuinely on camera. Either the recording has finished
 *            and the Q&A has opened, or a host went live early. Also the
 *            answer for any event with nothing to play (a hosted webinar),
 *            from before its start onwards.
 *   ended    A host pressed End for everyone, or the window has closed.
 */
export type PremierePhase = "waiting" | "playing" | "live" | "ended";

export type PremiereState = {
  phase: PremierePhase;
  /**
   * Where to seek the player, in seconds from the top of the recording. Only
   * meaningful while `phase === "playing"`.
   */
  offsetSeconds: number;
  /** Seconds until the next transition, for a countdown. Null when there is none. */
  secondsUntilNext: number | null;
};

/**
 * Resolve a premiere's phase from the clock.
 *
 * `now` is injected rather than read, for the same reason `joinState` injects
 * it: this has to be a pure function so the tests can pin it, and so a server
 * render can pass the request time and have every element on the page agree
 * with itself.
 *
 * The precedence is the interesting part, and there is one rule above all the
 * others: **`liveStartedAt` wins.** A host who presses "go live" thirty minutes
 * into a forty-minute recording has made a decision about the room, and the
 * schedule must yield to it immediately — the alternative is an audience
 * watching a recording of a person who is, at that moment, live on the other
 * side of the same page. Everything else is arithmetic on `startsAt`.
 *
 * With one exception above even that: **`liveEndedAt` ends it.** A host who
 * pressed End for everyone has ended the premiere too — a recording that kept
 * playing to viewers under an "Ended" badge was the bug that added this.
 *
 * And one rule about what a premiere IS: with `premiereSeconds` null there is
 * nothing to play, so there is nothing to wait for either. A hosted webinar
 * (which is what passes null) is 'live' from before its start — reading it as
 * a premiere in 'waiting' hid the host's camera controls and End button for
 * the whole early set-up window and then switched the camera on by itself at
 * the scheduled start.
 */
export function premiereState({
  startsAt,
  premiereSeconds,
  qaOpensAt,
  liveStartedAt,
  liveEndedAt,
  endsAt,
  now = new Date(),
}: {
  startsAt: string | Date;
  /**
   * Length of the recording. Null means there is nothing to play — a hosted
   * webinar, or a premiere whose file has not been uploaded — and the room is
   * simply live.
   */
  premiereSeconds: number | null;
  /** Explicit switch-over time, when a host wanted one. */
  qaOpensAt?: string | Date | null;
  /** Set once a host has actually gone live. */
  liveStartedAt?: string | Date | null;
  /** Set once a host has pressed End for everyone. Beats everything. */
  liveEndedAt?: string | Date | null;
  endsAt?: string | Date | null;
  now?: Date;
}): PremiereState {
  const t = now.getTime();
  const start = new Date(startsAt).getTime();

  // Ended for everyone. Terminal for the premiere as for the live room.
  if (liveEndedAt) {
    return { phase: "ended", offsetSeconds: 0, secondsUntilNext: null };
  }

  // A host is on camera. Nothing about the schedule matters any more.
  if (liveStartedAt) {
    const wentLive = new Date(liveStartedAt).getTime();
    if (t >= wentLive) {
      return { phase: "live", offsetSeconds: 0, secondsUntilNext: null };
    }
  }

  // Only a premiere with something to play waits for its start. Everything
  // else — and in particular every hosted webinar — is live the moment anyone
  // is let in.
  if (t < start && premiereSeconds) {
    return {
      phase: "waiting",
      offsetSeconds: 0,
      secondsUntilNext: Math.ceil((start - t) / 1000),
    };
  }

  // When the recording hands over. An explicit `qaOpensAt` is a host saying
  // "Q&A at the top of the hour" for a talk that runs forty minutes; without
  // one it is simply the end of the recording.
  const switchAt = qaOpensAt
    ? new Date(qaOpensAt).getTime()
    : premiereSeconds
      ? start + premiereSeconds * 1000
      : start;

  if (premiereSeconds && t < switchAt) {
    // Clamped to the recording's length, which matters when `qaOpensAt` is
    // later than the video is long: the last minutes then hold on the final
    // frame rather than asking the player to seek past the end, where browsers
    // disagree about what happens (some clamp, some fire `ended`, one seeks to
    // zero and starts the talk again in front of everyone).
    const offset = Math.min((t - start) / 1000, premiereSeconds);
    return {
      phase: "playing",
      offsetSeconds: Math.max(0, offset),
      secondsUntilNext: Math.ceil((switchAt - t) / 1000),
    };
  }

  const end = endsAt ? new Date(endsAt).getTime() : null;
  if (end !== null && t > end + 30 * 60_000) {
    return { phase: "ended", offsetSeconds: 0, secondsUntilNext: null };
  }

  return { phase: "live", offsetSeconds: 0, secondsUntilNext: null };
}

/**
 * How far the player may drift from where the clock says it should be before
 * it is corrected, in seconds.
 *
 * Some drift is unavoidable and re-seeking on every tick is worse than the
 * drift: a `<video>` that seeks constantly stutters, drops audio, and on
 * Safari can re-buffer for a second each time. Two seconds is under the
 * threshold where a viewer would notice the difference against anyone else's
 * screen, and well above the jitter of a normally-playing element.
 */
export const PREMIERE_DRIFT_TOLERANCE_SECONDS = 2;

/**
 * Does this event play a recording rather than a live camera?
 *
 * A one-line helper with a real job: `live_mode` has three values now, and
 * every `=== "hosted"` left over from when it had two is a place a premiere
 * silently behaves like an external link. Grep for this instead.
 */
export function isPremiere(liveMode: string | null | undefined): boolean {
  return liveMode === "premiere";
}

/** Does this event have a batch0-hosted room of any kind? */
export function isHostedOnBatch0(liveMode: string | null | undefined): boolean {
  return liveMode === "hosted" || liveMode === "premiere";
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

export type WebinarPoll = {
  id: string;
  eventId: string;
  question: string;
  options: string[];
  open: boolean;
  resultsVisible: boolean;
  /** Counts per option, same order as `options`. */
  tally: number[];
  /** The reader's own vote, or null. Never another person's. */
  myChoice: number | null;
  createdAt: string;
};

export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 6;
export const MAX_POLL_QUESTION_LENGTH = 300;
export const MAX_POLL_OPTION_LENGTH = 120;

/**
 * Clean a poll into something storable, or say why it can't be.
 *
 * Returns a discriminated result rather than throwing, because both callers
 * want the reason: the form shows it under the field as you type, and the
 * server action turns it into the thrown error. One implementation means the
 * button is never enabled for input the server will refuse.
 */
export function normalizePoll(input: {
  question: string;
  options: string[];
}): { ok: true; question: string; options: string[] } | { ok: false; error: string } {
  const question = input.question.replace(/\s+/g, " ").trim();
  if (!question) return { ok: false, error: "Write the poll question first." };
  if (question.length > MAX_POLL_QUESTION_LENGTH) {
    return { ok: false, error: "That question is too long." };
  }
  const options = input.options
    .map((o) => o.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((o) => o.slice(0, MAX_POLL_OPTION_LENGTH));
  if (options.length < MIN_POLL_OPTIONS) {
    return { ok: false, error: "A poll needs at least two options." };
  }
  if (options.length > MAX_POLL_OPTIONS) {
    return { ok: false, error: `A poll takes at most ${MAX_POLL_OPTIONS} options.` };
  }
  // Duplicates are not a validation nicety: two identical options split the
  // vote between them and make the result meaningless, and the voter has no
  // way to tell which one they picked.
  const seen = new Set(options.map((o) => o.toLowerCase()));
  if (seen.size !== options.length) {
    return { ok: false, error: "Two options say the same thing." };
  }
  return { ok: true, question, options };
}

/** Percentages for a tally, rounded so they still add to 100. */
export function pollPercentages(tally: readonly number[]): number[] {
  const total = tally.reduce((a, b) => a + b, 0);
  if (total === 0) return tally.map(() => 0);
  // Largest-remainder, because naive rounding of thirds shows "33% 33% 33%"
  // under a bar that visibly fills the row — and a poll whose numbers don't
  // add up is the kind of small wrongness an audience notices immediately.
  const exact = tally.map((n) => (n / total) * 100);
  const floors = exact.map(Math.floor);
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * The emoji a viewer can throw at the screen.
 *
 * Deliberately a short fixed list and not a picker. Reactions are never stored
 * — they are a Realtime broadcast that floats up the video and is gone — so
 * there is no moderation queue behind them, and the only thing keeping a room
 * of teenagers from putting something unpleasant on everyone's screen is that
 * the alphabet is this array. A free-text or full-emoji reaction would need the
 * whole moderation apparatus that chat has, for a feature whose entire value is
 * that it is instant.
 */
export const REACTIONS = ["👏", "🔥", "❤️", "😂", "🤯", "🎉"] as const;
export type Reaction = (typeof REACTIONS)[number];

export function isReaction(value: unknown): value is Reaction {
  return typeof value === "string" && (REACTIONS as readonly string[]).includes(value);
}

/**
 * Most reactions one viewer may send per second.
 *
 * Enforced in the browser only, and that is on purpose: a reaction is an
 * unstored broadcast, so the worst a determined student achieves by bypassing
 * it is a few extra emoji on their classmates' screens for as long as they keep
 * at it. Paying for a server round trip per clap to prevent that would cost the
 * feature its whole point.
 */
export const REACTION_RATE_PER_SECOND = 3;
