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
 * setting an admin chooses.
 *
 *   private    A viewer sees only their own questions, and there is no chat.
 *              Nothing on the wire tells one student that another exists. What
 *              an unreadable or missing value falls back to.
 *
 *   moderated  Viewers write; a host decides what the room sees. An unapproved
 *              message reaches the hosts and nobody else — enforced in RLS, not
 *              just here. The right setting for a public webinar in a program
 *              with minors: a live channel where nothing reaches the audience
 *              that a human has not read.
 *
 *   open       Ordinary live chat. Everyone sees every message and who wrote
 *              it, and hosts can remove any of it. The default for new events
 *              (DEFAULT_AUDIENCE_MODE; column default since migration 0098).
 *
 * Deliberately ONE knob rather than three (chat on/off, questions
 * public/private, upvotes on/off). All three are the same question, and
 * splitting them would let an admin pick a combination that hides through one
 * surface while leaking through another.
 */
export type AudienceMode = "private" | "moderated" | "open";

/** What a new event starts with: chat on. */
export const DEFAULT_AUDIENCE_MODE: AudienceMode = "open";

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

/**
 * One chat message as a reader receives it. Carries no user ids: `mine` is
 * all a client needs, and an id is one more thing a student could collect
 * about another.
 */
export type ChatMessage = {
  id: string;
  /** Resolved server-side. "You" for the reader's own messages. */
  authorName: string;
  mine: boolean;
  body: string;
  /** Was the author staff or a guest speaker when they sent it? */
  isHost: boolean;
  /** Null while waiting on a host in `moderated` mode. */
  approvedAt: string | null;
  /** Set once removed (by a host or its author). Such a row is never drawn. */
  removedAt: string | null;
  pinned: boolean;
  createdAt: string;
};

/** Author self-deletes: a spam ceiling, not a participation limit. */
export const CHAT_DELETE_LIMIT = 10;
export const CHAT_DELETE_WINDOW_SECONDS = 60;

/** Upvotes and poll votes: each one makes the whole room re-read, so toggling is capped. */
export const VOTE_LIMIT = 20;
export const VOTE_WINDOW_SECONDS = 10;

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
 * Slides are PDF only: a PDF is what the room can present (pdf.js) and what
 * the follow-up email can link. Export from Keynote / PowerPoint / Google
 * Slides as PDF.
 */
export const DECK_MIME_TYPES = ["application/pdf"] as const;

export const DECK_EXTENSIONS = [".pdf"] as const;

/**
 * Largest file the `webinar-media` bucket accepts (its `file_size_limit` in
 * migration 0084). Checked before uploading so a too-big file fails at once.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Is this file a usable deck? The extension alone is enough (some browsers
 * send an empty or generic type); a PDF MIME type with no extension also
 * passes.
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
 * `staffPresent` comes from the attendance table (fresh host rows whose own
 * role holds `events.manage` — presentHostRoles in lib/live-access.ts). When
 * that cannot be read the server passes `false`,
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
 * Does this event have a batch0-hosted room? A legacy premiere row counts: it
 * runs as a hosted room.
 */
export function isHostedOnBatch0(liveMode: string | null | undefined): boolean {
  return liveMode === "hosted" || liveMode === "premiere";
}

// ---------------------------------------------------------------------------
// Questions (as the room panel receives them)
// ---------------------------------------------------------------------------

export type RoomQuestion = {
  id: string;
  /** "You" for the reader's own; "A student" where names are withheld. */
  askerName: string;
  mine: boolean;
  body: string;
  status: "open" | "answered" | "dismissed";
  voteCount: number;
  /** Has the READER upvoted it. */
  voted: boolean;
  spotlighted: boolean;
  /** Null until a host lets it through (or it was asked in an open room). */
  approvedAt: string | null;
  createdAt: string;
};

/**
 * Queue order: the spotlight first, then open questions by votes (ties in the
 * order asked), then answered / dismissed at the bottom.
 */
export function sortQuestions<T extends Pick<RoomQuestion, "status" | "voteCount" | "spotlighted" | "createdAt">>(
  questions: readonly T[],
): T[] {
  const rank = (q: T) => (q.spotlighted ? 0 : q.status === "open" ? 1 : 2);
  return [...questions].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 1 ? b.voteCount - a.voteCount : 0) ||
      a.createdAt.localeCompare(b.createdAt),
  );
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

/**
 * May the audience see this poll? While it is open, and after it closes if
 * anyone voted (its result). A draft — never opened, so never voted on — stays
 * the host's private preparation.
 */
export function pollVisibleToAudience(
  poll: Pick<WebinarPoll, "open" | "tally">,
): boolean {
  return poll.open || poll.tally.some((n) => n > 0);
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
