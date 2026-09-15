import "server-only";
import { env } from "@/lib/env";
import type { LiveRole } from "@/lib/live";

/**
 * Daily REST wrapper — rooms and meeting tokens.
 *
 * Mirrors how lib/discord.ts wraps Discord: a thin, typed surface over their
 * HTTP API that no-ops or throws a named error when the integration isn't
 * configured, so an environment without a key degrades to "hosting
 * unavailable" instead of 500s.
 *
 * `server-only` is not decoration. DAILY_API_KEY mints owner tokens for every
 * room on the domain, so this module reaching a client bundle would hand every
 * visitor host rights to every call the site hosts. The import makes that a
 * build error rather than something to notice in review.
 *
 * ---------------------------------------------------------------------------
 * The access model, in one place
 * ---------------------------------------------------------------------------
 *
 * 1. Every room is created `privacy: "private"`. A private room cannot be
 *    joined without a meeting token, so a leaked room URL is worthless on its
 *    own — which matters because room URLs end up in calendar invites, email,
 *    and browser history.
 *
 * 2. Tokens are minted server-side, only after the caller has passed the same
 *    permission and RLS checks that guard the rest of the site. There is no
 *    second access-control system to drift out of sync: who may join a webinar
 *    is exactly who the `events` RLS policy already lets read the event.
 *
 * 3. Both room and token carry an `exp`, plus `eject_at_token_exp`, so access
 *    expires on its own rather than depending on anyone remembering to revoke
 *    it.
 *
 * 4. Webinar viewers get `hasPresence: false`. They are absent from every
 *    other client's participant list and cannot send media — which is what
 *    makes "students can't see the audience" a property of the room rather
 *    than of our CSS. See canSeeRoster() in lib/live.ts.
 */

const API = "https://api.daily.co/v1";

/** Thrown when a Daily call fails. Carries the status for callers that care. */
export class DailyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DailyError";
  }
}

/** True when both env vars are present. Every caller should check first. */
export function dailyConfigured(): boolean {
  return !!env.dailyApiKey && !!env.dailyDomain;
}

function requireKey(): string {
  if (!env.dailyApiKey) {
    throw new DailyError(
      "Live video isn't configured — DAILY_API_KEY is missing.",
    );
  }
  return env.dailyApiKey;
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${requireKey()}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    // These are per-request writes and reads that gate access; never serve
    // them from Next's Data Cache.
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Deliberately does not echo the response body into the message
    // unfiltered — Daily errors are safe, but this string can reach a client
    // transition via a server action, so keep it short and intentional.
    //
    // One Daily failure is worth naming, because its raw text sends people
    // hunting in the wrong place: "account is missing a payment method" does
    // NOT mean a student's card failed. It means the Daily account this
    // DAILY_API_KEY belongs to has no card on file and the room asked for a
    // paid feature (cloud recording, or large-call scale). The fix lives on the
    // account or in env, never in a user's billing — so say so where a
    // stack-trace reader will actually see it.
    const paidFeature = /payment method/i.test(text);
    throw new DailyError(
      `Daily ${init.method} ${path} failed (${res.status})${
        text ? `: ${text.slice(0, 200)}` : ""
      }${
        paidFeature
          ? " — the Daily account (DAILY_API_KEY) has no payment method and the" +
            " room requested a paid feature. Add a card in the Daily dashboard," +
            " or unset DAILY_ENABLE_RECORDING / DAILY_LARGE_CALLS to stop" +
            " requesting paid features."
          : ""
      }`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export type RoomMode =
  /** Webinar: only owners get camera/mic. Everyone else watches. */
  | "webinar"
  /** 1:1 or small group: everyone can broadcast. */
  | "meeting";

export type DailyRoom = {
  name: string;
  url: string;
};

/**
 * Create a private room.
 *
 * `expiresAt` should be the end of the session plus a grace window. Daily
 * deletes the room itself at `exp`, so this doubles as cleanup — there is no
 * cron job reaping stale rooms because there are no stale rooms.
 */
export async function createRoom({
  namePrefix,
  mode,
  expiresAt,
  enableRecording = false,
}: {
  namePrefix: string;
  mode: RoomMode;
  expiresAt: Date;
  enableRecording?: boolean;
}): Promise<DailyRoom> {
  const room = await call<{ name: string; url: string }>("/rooms", {
    method: "POST",
    body: {
      // Daily room names must be URL-safe and unique on the domain. The
      // random suffix means a deleted-and-recreated session never collides
      // with a cached URL from the previous one.
      name: `${slug(namePrefix)}-${randomSuffix()}`,
      privacy: "private",
      properties: {
        exp: unix(expiresAt),
        eject_at_room_exp: true,
        // Non-owners get no camera or mic at all in webinar mode. This is the
        // room-level half of the host/viewer split; the token's is_owner is
        // the other half.
        owner_only_broadcast: mode === "webinar",
        enable_screenshare: true,
        // 1:1s use Daily's built-in chat. Webinars do NOT: a webinar viewer
        // joins hidden (hasPresence:false) and Prebuilt only lets a hidden
        // participant *read* chat, not send — so leaving it on would show
        // students a chat they can't post to. Their questions go through our
        // own Q&A instead (webinar_questions, 0060), which keeps them hidden.
        enable_chat: mode === "meeting",
        enable_prejoin_ui: false, // we ship our own green room (PreJoin)
        // Cloud recording is paid — a free plan 400s the whole room create if
        // this is set at all. So it's requested only when a caller wants it AND
        // the account is configured for it (env.dailyRecording). Omitted, not
        // set to false: `undefined` keys drop out of the JSON entirely.
        enable_recording:
          enableRecording && env.dailyRecording ? "cloud" : undefined,
        // Daily's large-call optimization. Only needed above 50 participants
        // (Daily requires it there, and Prebuilt requires it for calls that
        // large) — but it is NOT free: it opts the room into paid-scale
        // infrastructure, and a Daily account with no payment method rejects
        // room creation with "account is missing a payment method". batch0
        // webinars are nowhere near 50, so it stays off unless
        // env.dailyLargeCalls is set — exactly like enable_recording above.
        // `undefined` drops the key from the JSON entirely, so a normal webinar
        // asks Daily for nothing paid and works on any plan.
        experimental_optimize_large_calls:
          mode === "webinar" && env.dailyLargeCalls ? true : undefined,
      },
    },
  });
  return { name: room.name, url: room.url };
}

/**
 * Is this room still live — present on Daily, and not past its own `exp`?
 *
 * Any caller reusing a room name it stored earlier must ask this first,
 * because minting a token for a room that is gone still *succeeds*. Nothing
 * fails server-side; the only symptom is the browser refusing to connect,
 * which is a miserable thing to debug from a screenshot.
 *
 * Two separate ways a stored name goes bad, and callers care about neither
 * individually. Rooms are deleted at `exp`, so most dead names 404. But that
 * reaping lags expiry, so a room can still resolve while being past its `exp`
 * and unjoinable — treating that as live would hand out a token for a room
 * nobody can enter, which is the whole failure this guards against.
 *
 * `until` is the instant the room has to survive to — a session's end, for a
 * caller about to hand out tokens for the whole session. Defaults to now. A
 * room that is alive this minute but expires before the session ends would
 * eject everyone mid-sentence (`eject_at_room_exp`), which from the audience's
 * side is indistinguishable from the room having been gone all along.
 *
 * A 404 is the answer "no", not an error. Every other status is a real
 * failure and propagates, exactly as room creation would.
 */
export async function roomIsLive(
  name: string,
  until: Date = new Date(),
): Promise<boolean> {
  let room: { config?: { exp?: number } };
  try {
    room = await call(`/rooms/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err instanceof DailyError && err.status === 404) return false;
    throw err;
  }
  const exp = room.config?.exp;
  // A room created without an `exp` never expires on its own.
  return exp === undefined || exp * 1000 > until.getTime();
}

/**
 * Move a room's `exp` to follow a rescheduled session.
 *
 * A room is created with `exp` = the session's end plus a grace window, and
 * Daily deletes it then. That is the right cleanup — until the event is moved
 * later: the row keeps the room's name, the room keeps its old `exp`, and on
 * the new date the join page mints tokens for a room Daily already reaped.
 * So a reschedule re-stamps the room instead.
 *
 * Returns false when the room is already gone (404) — the caller should make
 * a new one — and propagates every other failure, as creation would.
 */
export async function updateRoomExpiry(
  name: string,
  expiresAt: Date,
): Promise<boolean> {
  try {
    await call(`/rooms/${encodeURIComponent(name)}`, {
      method: "POST",
      body: { properties: { exp: unix(expiresAt) } },
    });
    return true;
  } catch (err) {
    if (err instanceof DailyError && err.status === 404) return false;
    throw err;
  }
}

export async function deleteRoom(name: string): Promise<void> {
  try {
    await call(`/rooms/${encodeURIComponent(name)}`, { method: "DELETE" });
  } catch (err) {
    // A room that is already gone (404) is the desired end state, and rooms
    // expire on their own via `exp`. Deleting an event should not fail
    // because cleanup of an already-cleaned room 404'd.
    if (err instanceof DailyError && err.status === 404) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Meeting tokens
// ---------------------------------------------------------------------------

/**
 * Mint a join token for one person in one room.
 *
 * CALLERS MUST AUTHORIZE FIRST. This function deliberately performs no checks
 * of its own — it cannot, since it has no idea what the room is for. Every
 * call site is responsible for having run the relevant `assertPermission` or
 * RLS-scoped read before reaching here, and for passing a `role` it actually
 * derived rather than one it accepted from the client.
 */
export async function mintToken({
  roomName,
  userId,
  userName,
  role,
  expiresAt,
}: {
  roomName: string;
  userId: string;
  userName: string;
  role: LiveRole;
  expiresAt: Date;
}): Promise<string> {
  const isHost = role === "host";
  const { token } = await call<{ token: string }>("/meeting-tokens", {
    method: "POST",
    body: {
      properties: {
        room_name: roomName,
        user_id: userId,
        user_name: userName,
        is_owner: isHost,
        exp: unix(expiresAt),
        eject_at_token_exp: true,
        // The audience-privacy guarantee, enforced by the provider rather
        // than by our UI: a viewer with hasPresence:false is absent from
        // participants() for everyone else and cannot send media. Without
        // this, hiding the roster in CallStage is defeated by devtools.
        ...(isHost ? {} : { permissions: { hasPresence: false } }),
        // Only owners may start a recording, and only when the plan allows it.
        // Set to "cloud" solely for a host on a recording-enabled account;
        // otherwise omitted, because a free plan rejects a token that carries
        // enable_recording at all.
        ...(isHost && env.dailyRecording
          ? { enable_recording: "cloud" as const }
          : {}),
      },
    },
  });
  return token;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/** Daily room names allow letters, digits, hyphen and underscore. */
function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "room"
  );
}

function randomSuffix(): string {
  // Node's webcrypto — available in both the Node and Edge runtimes, and
  // unlike Math.random it is not predictable from a previous room name.
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
