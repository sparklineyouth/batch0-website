import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import type { EventAccess } from "@/lib/live-access";
import type { WebinarQuestion } from "@/lib/live";
import { liveParticipants } from "@/lib/live-rooms";
import { PEER_TIMEOUT_MS } from "@/lib/live-signal";
import {
  audienceCanSeeEachOther,
  pollVisibleToAudience,
  type AssetKind,
  type AudienceMode,
  type ChatMessage,
  type EventAsset,
  type EventSpeaker,
  type RoomQuestion,
  type WebinarPoll,
} from "@/lib/webinars";
import {
  laterIso,
  readFrom,
  CHAT_PAGE,
  PANEL_PARTS,
  type PanelPeople,
  type PanelRead,
  type PanelReadPart,
  type WebinarPanelInitial,
} from "@/lib/webinar-panel";
import {
  listQuestionsForAsker,
  listQuestionsForEvent,
  listVisibleQuestions,
  questionsVotedBy,
} from "@/lib/webinar-questions";

export type { WebinarPanelInitial } from "@/lib/webinar-panel";

/**
 * Service-role reads for webinars — speakers, files, chat and polls.
 *
 * The same contract lib/webinar-questions.ts states and for the same reason:
 * these are service-role queries with explicit filters, so one round trip can
 * join an author's name, and **the caller decides the scope and passes it in**.
 * RLS on the tables (migration 0084) is still the backstop; the filters here
 * are what keep the backstop from ever being the thing that saves us.
 *
 * Two rules run through every function below.
 *
 * 1. NO `select *`. Every read names its columns. `event_speakers.claim_token`
 *    is a column on a row a whole cohort can read, and a wildcard select would
 *    put a working invite link into a page payload. Naming columns means a
 *    future column is opt-in rather than opt-out.
 *
 * 2. Nothing here decides who may call it. There is deliberately no
 *    `listChatFor(userId)` that works out a role — the caller has already done
 *    the authorization (it is the same `resolveEventAccess` gate the live room
 *    runs, lib/live-access.ts) and passes the answer down. A function that guesses its own permissions is
 *    a function with two sources of truth.
 */

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

/**
 * Who is speaking at this event.
 *
 * `includePrivate` is the switch between the two audiences for this list: a
 * student gets the cards (name, title, bio, photo), and staff additionally get
 * the email and whether an invite is still unclaimed. The claim token itself is
 * never returned by this function at all — the one place that needs it mints
 * the link at the moment it sends the invite, so a live token has no reason to
 * exist in any page payload.
 */
export async function listSpeakers(
  eventId: string,
  includePrivate = false,
): Promise<EventSpeaker[]> {
  const admin = createAdminClient();
  const columns = includePrivate
    ? "id, event_id, user_id, name, title, bio, photo_url, link_url, email, sort_order"
    : "id, event_id, user_id, name, title, bio, photo_url, link_url, sort_order";
  const { data, error } = await admin
    .from("event_speakers")
    .select(columns)
    .eq("event_id", eventId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) {
    if (!isMissingSchemaError(error)) {
      console.error("[webinars] speaker read failed", error.message);
    }
    return [];
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    eventId: r.event_id,
    userId: r.user_id ?? null,
    name: r.name,
    title: r.title ?? null,
    bio: r.bio ?? null,
    photoUrl: r.photo_url ?? null,
    linkUrl: r.link_url ?? null,
    ...(includePrivate ? { email: r.email ?? null } : {}),
    sortOrder: r.sort_order ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const BUCKET = "webinar-media";

/** Files attached to an event, optionally narrowed to some kinds. */
export async function listAssets(
  eventId: string,
  kinds?: readonly AssetKind[],
): Promise<EventAsset[]> {
  const admin = createAdminClient();
  let query = admin
    .from("event_assets")
    .select(
      "id, event_id, kind, storage_path, filename, mime_type, size_bytes, duration_seconds, sort_order, created_at",
    )
    .eq("event_id", eventId);
  if (kinds && kinds.length > 0) query = query.in("kind", kinds as string[]);
  const { data, error } = await query
    .order("kind", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    // A recording is one row per two minutes, so an eight-hour cap's worth of
    // segments is about two hundred and forty. 500 is above anything real and
    // far below anything that would hurt.
    .limit(500);
  if (error) {
    if (!isMissingSchemaError(error)) {
      console.error("[webinars] asset read failed", error.message);
    }
    return [];
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    eventId: r.event_id,
    kind: r.kind,
    storagePath: r.storage_path,
    filename: r.filename,
    mimeType: r.mime_type ?? null,
    sizeBytes: r.size_bytes ?? null,
    durationSeconds: r.duration_seconds ?? null,
    sortOrder: r.sort_order ?? 0,
    createdAt: r.created_at,
  }));
}

/**
 * A short-lived URL for one file.
 *
 * CALLERS MUST AUTHORIZE FIRST — the same contract `credentialsFor` states.
 * This signs whatever path it is handed with the service role and asks no
 * questions, because it has no idea whether the caller may have the bytes.
 * Every call site has already read the event through the caller's own RLS.
 *
 * Ten minutes, matching the rest of the repo's per-click signed reads. Long
 * enough for a slow connection to start a 500 MB download, short enough that a
 * URL pasted into a group chat is dead before it is useful — and the download
 * itself continues past expiry once it has begun, so a long TTL buys nothing.
 */
export async function signedAssetUrl(
  storagePath: string,
  expiresInSeconds = 60 * 10, // 10 minutes
  downloadAs?: string,
): Promise<string | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(
        storagePath,
        expiresInSeconds,
        downloadAs ? { download: downloadAs } : undefined,
      );
    if (error) {
      console.error("[webinars] sign failed", error.message);
      return null;
    }
    return data?.signedUrl ?? null;
  } catch (err) {
    console.error("[webinars] sign threw", err);
    return null;
  }
}

/** Sign a batch of files for one render, keeping the round trips to one each. */
export async function signAssets(
  assets: readonly EventAsset[],
  expiresInSeconds = 60 * 10, // 10 minutes
): Promise<(EventAsset & { url: string | null })[]> {
  return Promise.all(
    assets.map(async (a) => ({
      ...a,
      url: await signedAssetUrl(a.storagePath, expiresInSeconds, a.filename),
    })),
  );
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const CHAT_SELECT =
  "id, author_id, body, is_host, approved_at, removed_at, pinned, created_at, " +
  "author:profiles!webinar_messages_author_id_fkey(full_name)";

/** PostgREST returns an embed as an object or a one-element array. */
function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** What a student is called where names are withheld (guest speakers). */
const WITHHELD_NAME = "A student";

function toChatMessage(
  row: any,
  readerId: string,
  withholdNames: boolean,
): ChatMessage {
  const author = one<any>(row.author);
  const mine = row.author_id === readerId;
  return {
    id: row.id,
    authorName: mine
      ? "You"
      : withholdNames && !row.is_host
        ? WITHHELD_NAME
        : author?.full_name || WITHHELD_NAME,
    mine,
    body: row.body,
    isHost: !!row.is_host,
    approvedAt: row.approved_at ?? null,
    removedAt: row.removed_at ?? null,
    pinned: !!row.pinned,
    createdAt: row.created_at,
  };
}

/**
 * The room's chat, shaped by who is asking.
 *
 * Removed rows are never returned — to anyone, moderators included — so a
 * removal sticks on every refresh. A moderator also gets pending rows (the
 * queue); everyone else gets approved rows plus their own pending ones.
 *
 * Without `since`: the NEWEST `CHAT_PAGE`, oldest first. With it: rows created
 * after `since` minus the overlap (see CHAT_CURSOR_OVERLAP_MS).
 */
export async function listChat({
  eventId,
  readerId,
  forModerator,
  withholdNames,
  since,
}: {
  eventId: string;
  readerId: string;
  forModerator: boolean;
  withholdNames: boolean;
  since: string | null;
}): Promise<{ messages: ChatMessage[]; cursor: string | null }> {
  const admin = createAdminClient();
  let query = admin
    .from("webinar_messages")
    .select(CHAT_SELECT)
    .eq("event_id", eventId)
    .is("removed_at", null);
  if (!forModerator) {
    query = query.or(`approved_at.not.is.null,author_id.eq.${readerId}`);
  }
  if (since) query = query.gt("created_at", readFrom(since));
  const ascending = !!since;
  const { data, error } = await query
    .order("created_at", { ascending })
    .order("id", { ascending })
    .limit(CHAT_PAGE);
  if (error) {
    if (!isMissingSchemaError(error)) {
      console.error("[webinars] chat read failed", error.message);
    }
    return { messages: [], cursor: since };
  }
  const rows = ascending ? (data ?? []) : [...(data ?? [])].reverse();
  const messages = rows.map((r) => toChatMessage(r, readerId, withholdNames));
  return {
    messages,
    cursor: laterIso(since, messages.at(-1)?.createdAt ?? null),
  };
}

/** The one message a host has pinned, if the reader may see it. */
export async function pinnedMessage({
  eventId,
  readerId,
  forModerator,
  withholdNames,
}: {
  eventId: string;
  readerId: string;
  forModerator: boolean;
  withholdNames: boolean;
}): Promise<ChatMessage | null> {
  const admin = createAdminClient();
  let query = admin
    .from("webinar_messages")
    .select(CHAT_SELECT)
    .eq("event_id", eventId)
    .eq("pinned", true)
    .is("removed_at", null);
  if (!forModerator) query = query.not("approved_at", "is", null);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return toChatMessage(data, readerId, withholdNames);
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

/**
 * Polls for one event, with the tally and the reader's own vote.
 *
 * A moderator gets every poll, drafts included. Everyone else gets what
 * `pollVisibleToAudience` allows (open, or closed with a result), and a hidden
 * result arrives zeroed. A tally is counted here rather than in SQL: a
 * group-by PostgREST cannot express, over a few hundred rows.
 */
export async function listPolls({
  eventId,
  readerId,
  forModerator,
}: {
  eventId: string;
  readerId: string;
  forModerator: boolean;
}): Promise<WebinarPoll[]> {
  const admin = createAdminClient();
  const { data: polls, error } = await admin
    .from("webinar_polls")
    .select("id, event_id, question, options, open, results_visible, created_at")
    .eq("event_id", eventId)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) {
    if (!isMissingSchemaError(error)) {
      console.error("[webinars] poll read failed", error.message);
    }
    return [];
  }
  const rows = (polls ?? []) as any[];
  if (rows.length === 0) return [];

  const { data: votes } = await admin
    .from("webinar_poll_votes")
    .select("poll_id, voter_id, choice")
    .in(
      "poll_id",
      rows.map((p) => p.id),
    )
    .limit(5000);

  const tallies = new Map<string, number[]>();
  const mine = new Map<string, number>();
  for (const p of rows) {
    tallies.set(p.id, new Array(optionsOf(p).length).fill(0));
  }
  for (const v of (votes ?? []) as any[]) {
    const t = tallies.get(v.poll_id);
    // A choice outside the options cannot be written (RLS bounds it), but a
    // hand-edited poll could strand one; ignoring it beats rendering NaN.
    if (t && v.choice >= 0 && v.choice < t.length) t[v.choice] += 1;
    if (v.voter_id === readerId) mine.set(v.poll_id, v.choice);
  }

  const all: WebinarPoll[] = rows.map((p) => ({
    id: p.id,
    eventId: p.event_id,
    question: p.question,
    options: optionsOf(p),
    open: !!p.open,
    resultsVisible: !!p.results_visible,
    tally: tallies.get(p.id) ?? [],
    myChoice: mine.has(p.id) ? mine.get(p.id)! : null,
    createdAt: p.created_at,
  }));
  if (forModerator) return all;
  return all
    .filter(pollVisibleToAudience)
    .map((p) => (p.resultsVisible ? p : { ...p, tally: p.tally.map(() => 0) }));
}

/** jsonb comes back parsed, but a hand-written row could hold anything. */
function optionsOf(row: any): string[] {
  const raw = row.options;
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => String(o));
}

// ---------------------------------------------------------------------------
// The side panel, in one read
// ---------------------------------------------------------------------------

/** Who is reading, as the room gate resolved them. */
export type PanelReader = {
  eventId: string;
  userId: string;
  audienceMode: AudienceMode;
  /** Staff or a guest speaker on this event. */
  isModerator: boolean;
  /** False for a guest speaker: students appear as "A student". */
  discloseNames: boolean;
};

/**
 * Chat, questions and polls for one reader. CALLERS MUST GATE FIRST (the
 * room gate or the page's access check); this only shapes by the role given.
 *
 * Questions follow the audience rule: a moderator reads the whole queue; a
 * viewer reads approved + own where the audience may see itself, and only
 * their own in a `private` room.
 */
export async function loadPanelState(
  reader: PanelReader,
  opts: { parts: readonly PanelReadPart[]; since: string | null },
): Promise<PanelRead> {
  const { eventId, userId, isModerator } = reader;
  const chatOn = audienceCanSeeEachOther(reader.audienceMode);
  const withholdNames = !reader.discloseNames;
  const want = new Set(opts.parts);

  const [chat, pinned, questions, polls, people] = await Promise.all([
    want.has("chat") && chatOn
      ? listChat({
          eventId,
          readerId: userId,
          forModerator: isModerator,
          withholdNames,
          since: opts.since,
        })
      : null,
    want.has("chat") && chatOn
      ? pinnedMessage({ eventId, readerId: userId, forModerator: isModerator, withholdNames })
      : null,
    want.has("qa") ? readQuestions(reader, chatOn) : null,
    want.has("poll")
      ? listPolls({ eventId, readerId: userId, forModerator: isModerator })
      : null,
    want.has("people") && isModerator ? readPeople(reader) : null,
  ]);

  const read: PanelRead = { audienceMode: reader.audienceMode };
  if (want.has("chat")) {
    read.chat = {
      messages: chat?.messages ?? [],
      pinned,
      full: !opts.since,
      cursor: chat?.cursor ?? opts.since,
    };
  }
  if (questions) read.questions = questions;
  if (polls) read.polls = polls;
  if (people) read.people = people;
  return read;
}

/**
 * Who is here, for a host: the same attendance-backed roster the engine
 * reconciles against (liveParticipants), names only, the reader left out. A
 * guest speaker gets the count and never the viewers' names.
 */
async function readPeople(reader: PanelReader): Promise<PanelPeople> {
  const peers = (
    await liveParticipants(
      reader.eventId,
      `event:${reader.eventId}`,
      PEER_TIMEOUT_MS,
      reader.discloseNames,
    )
  ).filter((p) => p.peerId !== reader.userId);
  const viewers = peers.filter((p) => p.role !== "host");
  return {
    hosts: peers.filter((p) => p.role === "host").map((p) => p.name || "Host"),
    viewers: reader.discloseNames ? viewers.map((p) => p.name || "Student") : null,
    watching: viewers.length,
  };
}

async function readQuestions(
  reader: PanelReader,
  chatOn: boolean,
): Promise<RoomQuestion[]> {
  const { eventId, userId } = reader;
  const rows = reader.isModerator
    ? await listQuestionsForEvent(eventId)
    : chatOn
      ? await listVisibleQuestions(eventId, userId)
      : await listQuestionsForAsker(eventId, userId);
  const voted = chatOn
    ? await questionsVotedBy(
        userId,
        rows.map((q) => q.id),
      )
    : new Set<string>();
  return rows.map((q) => {
    const mine = q.askerId === userId;
    return {
      id: q.id,
      askerName: mine ? "You" : reader.discloseNames ? q.askerName : WITHHELD_NAME,
      mine,
      body: q.body,
      status: q.status,
      voteCount: q.voteCount,
      voted: voted.has(q.id),
      spotlighted: q.spotlighted,
      approvedAt: q.approvedAt,
      createdAt: q.createdAt,
    };
  });
}

/**
 * The panel's server-rendered first state, for the live page. `access` is the
 * page's own resolveEventAccess answer for this event; the page has already
 * applied the room window.
 */
export async function loadWebinarPanelInitial(
  eventId: string,
  access: EventAccess,
): Promise<WebinarPanelInitial> {
  if (access.event.id !== eventId) {
    throw new Error("loadWebinarPanelInitial: access is for another event");
  }
  const read = await loadPanelState(
    {
      eventId,
      userId: access.userId,
      audienceMode: access.event.audienceMode,
      isModerator: access.isHost,
      discloseNames: access.discloseNames,
    },
    { parts: PANEL_PARTS, since: null },
  );
  return {
    ...read,
    chat: read.chat ?? { messages: [], pinned: null, full: true, cursor: null },
    questions: read.questions ?? [],
    polls: read.polls ?? [],
  };
}

/**
 * The legacy question list (the Daily room's QAPanel): the whole queue for a
 * host, only their own for anyone else. A guest speaker sees students as "A
 * student", and no asker id but the reader's own leaves the server.
 */
export async function listLegacyQuestions(
  access: EventAccess,
): Promise<WebinarQuestion[]> {
  const rows = access.isHost
    ? await listQuestionsForEvent(access.event.id)
    : await listQuestionsForAsker(access.event.id, access.userId);
  return rows.map((q) => {
    const mine = q.askerId === access.userId;
    return {
      id: q.id,
      eventId: q.eventId,
      askerId: mine ? access.userId : "",
      askerName: mine || access.discloseNames ? q.askerName : WITHHELD_NAME,
      body: q.body,
      status: q.status,
      createdAt: q.createdAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export type AttendanceRow = {
  userId: string;
  name: string;
  email: string | null;
  role: string;
  joinedAt: string;
  lastSeenAt: string;
  leftAt: string | null;
  /** Rounded up to the minute — nobody needs the seconds. */
  minutes: number;
};

/**
 * Who attended, and for how long.
 *
 * STAFF ONLY. This is the attendance record of a room that may contain minors,
 * and it is exactly the thing a guest speaker is not given (see `discloseNames`
 * in lib/live-rooms.ts). There is deliberately no viewer-shaped variant.
 *
 * `minutes` is (left, or last seen) minus joined, capped at the moment a host
 * pressed End for everyone (`events.live_ended_at`), and a row that joined
 * after End is dropped. What that does and does not get right:
 *
 *   - A tab closed without a Leave over-counts by up to PEER_TIMEOUT_MS (the
 *     heartbeat stops; last_seen_at is at most one beat stale). Bounded, and in
 *     the student's favour.
 *   - A viewer idling on the ended screen is NOT credited past End, whether or
 *     not their tab ever heard about it — End also closes every open row, and
 *     announcePresence stops touching attendance for an ended event.
 *   - Leaving and rejoining counts the gap as attended. The row keeps its
 *     FIRST joined_at (it is one row per person per event), and exact minutes
 *     across gaps would need per-session rows or an accumulated counter — a
 *     migration this record does not have yet. This is an over-count, never
 *     an under-count.
 */
export async function listAttendance(
  eventId: string,
): Promise<AttendanceRow[]> {
  const admin = createAdminClient();
  const [{ data, error }, { data: ev }] = await Promise.all([
    admin
      .from("live_participants")
      .select(
        "user_id, role, display_name, joined_at, last_seen_at, left_at, " +
          "profile:profiles!live_participants_user_id_fkey(email)",
      )
      .eq("event_id", eventId)
      .order("joined_at", { ascending: true })
      .limit(1000),
    admin.from("events").select("live_ended_at").eq("id", eventId).maybeSingle(),
  ]);
  if (error) {
    if (!isMissingSchemaError(error)) {
      console.error("[webinars] attendance read failed", error.message);
    }
    return [];
  }
  const endedAt = (ev as any)?.live_ended_at
    ? new Date((ev as any).live_ended_at).getTime()
    : null;
  return (data ?? [])
    .filter(
      (r: any) => endedAt === null || new Date(r.joined_at).getTime() <= endedAt,
    )
    .map((r: any) => {
      const seen = new Date(r.left_at ?? r.last_seen_at).getTime();
      const end = endedAt === null ? seen : Math.min(seen, endedAt);
      const start = new Date(r.joined_at).getTime();
      const profile = one<any>(r.profile);
      return {
        userId: r.user_id,
        name: r.display_name || "Student",
        email: profile?.email ?? null,
        role: r.role,
        joinedAt: r.joined_at,
        lastSeenAt: r.last_seen_at,
        leftAt: r.left_at ?? null,
        minutes: Math.max(0, Math.round((end - start) / 60_000)),
      };
    });
}
