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

/**
 * Which `sort_order` a newly uploaded recording segment should be registered
 * at, given the segments the event already has.
 *
 *   - The same file registered again (the same storage path) is the SAME
 *     segment — a retried register after a dropped response. It keeps its
 *     slot, so the recording can never play those five minutes twice.
 *   - A free index is taken as asked.
 *   - An index already held by a DIFFERENT file is appended after the last
 *     segment instead of replacing it.
 *
 * That third case is the one the old upsert got wrong in the other direction.
 * `useRecorder` numbers segments from zero each time the page loads, so a host
 * who reloads twenty minutes into a webinar starts a second run whose
 * segment 0 arrives while the first run's segment 0 is already registered.
 * "Replace" — which is what `onConflict` meant — silently deleted the start of
 * the webinar. The recorder never retries an upload itself (its header says
 * why), so a different file at a taken index is never a retry; it is always a
 * later run, and later belongs after.
 *
 * Pure so the rule is pinned in lib/webinars.test.ts. The caller re-reads and
 * re-asks if its insert then loses a race for the slot (23505).
 */
export function recordingSegmentSlot(
  requested: number,
  storagePath: string,
  taken: readonly { sortOrder: number; storagePath: string }[],
): { kind: "existing"; sortOrder: number } | { kind: "insert"; sortOrder: number } {
  const same = taken.find((t) => t.storagePath === storagePath);
  if (same) return { kind: "existing", sortOrder: same.sortOrder };
  const index = Number.isInteger(requested) && requested >= 0 ? requested : 0;
  if (!taken.some((t) => t.sortOrder === index)) {
    return { kind: "insert", sortOrder: index };
  }
  const last = taken.reduce((m, t) => Math.max(m, t.sortOrder), -1);
  return { kind: "insert", sortOrder: last + 1 };
}

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
 * The rule the live role is derived from, in one place so the page, the join
 * action and the announce action cannot drift. `events.manage` is the staff
 * grant; a speaker row is the per-event grant that exists so a guest does not
 * have to be handed the admin panel for forty minutes of talking.
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
 *            and the Q&A has opened, or a host went live early.
 *   ended    The window has closed.
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
 */
export function premiereState({
  startsAt,
  premiereSeconds,
  qaOpensAt,
  liveStartedAt,
  endsAt,
  now = new Date(),
}: {
  startsAt: string | Date;
  /** Length of the recording. Null means there is nothing to play. */
  premiereSeconds: number | null;
  /** Explicit switch-over time, when a host wanted one. */
  qaOpensAt?: string | Date | null;
  /** Set once a host has actually gone live. */
  liveStartedAt?: string | Date | null;
  endsAt?: string | Date | null;
  now?: Date;
}): PremiereState {
  const t = now.getTime();
  const start = new Date(startsAt).getTime();

  // A host is on camera. Nothing about the schedule matters any more.
  if (liveStartedAt) {
    const wentLive = new Date(liveStartedAt).getTime();
    if (t >= wentLive) {
      return { phase: "live", offsetSeconds: 0, secondsUntilNext: null };
    }
  }

  if (t < start) {
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
