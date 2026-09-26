import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  normalizeAudienceMode,
  type AssetKind,
  type AudienceMode,
  type ChatMessage,
  type EventAsset,
  type EventSpeaker,
  type WebinarPoll,
} from "@/lib/webinars";

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
 *    the authorization (it is the same `resolveRoom` gate the live room runs)
 *    and passes the answer down. A function that guesses its own permissions is
 *    a function with two sources of truth.
 */

// ---------------------------------------------------------------------------
// The event, as a webinar
// ---------------------------------------------------------------------------

export type WebinarEvent = {
  id: string;
  title: string;
  description: string | null;
  type: string;
  startsAt: string;
  endsAt: string | null;
  liveMode: string;
  audienceMode: AudienceMode;
  autoRecord: boolean;
  autoShare: boolean;
  premiereSeconds: number | null;
  qaOpensAt: string | null;
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  displayViewerCount: number | null;
  recordingUrl: string | null;
  cohortId: string | null;
  visibility: string;
};

/**
 * The columns every webinar surface needs, in one string.
 *
 * Shared so the live page, the join action and the follow-up cron cannot end
 * up reading different subsets and disagreeing about what an event is. Note
 * this is the list passed to an RLS-scoped client as often as to the admin
 * one — it names no column a student may not see.
 */
export const WEBINAR_EVENT_COLUMNS =
  "id, title, description, type, starts_at, ends_at, live_mode, audience_mode, " +
  "auto_record, auto_share, premiere_seconds, qa_opens_at, live_started_at, " +
  "live_ended_at, display_viewer_count, recording_url, cohort_id, visibility";

export function toWebinarEvent(row: any): WebinarEvent {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    type: row.type,
    startsAt: row.starts_at,
    endsAt: row.ends_at ?? null,
    liveMode: row.live_mode,
    // Normalised rather than cast. A row written before 0084 has no value here
    // at all, and `private` is the answer that discloses least — see the note
    // on normalizeAudienceMode.
    audienceMode: normalizeAudienceMode(row.audience_mode),
    autoRecord: !!row.auto_record,
    autoShare: !!row.auto_share,
    premiereSeconds: row.premiere_seconds ?? null,
    qaOpensAt: row.qa_opens_at ?? null,
    liveStartedAt: row.live_started_at ?? null,
    liveEndedAt: row.live_ended_at ?? null,
    displayViewerCount: row.display_viewer_count ?? null,
    recordingUrl: row.recording_url ?? null,
    cohortId: row.cohort_id ?? null,
    visibility: row.visibility,
  };
}

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
    if (!isMissingTable(error)) {
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

/**
 * Just the ids, for the authorization check on the join path.
 *
 * A separate, narrower query rather than `listSpeakers().map(...)` because this
 * one runs on every join, every heartbeat, and every question — and it should
 * cost an index probe rather than a read of every speaker's biography.
 */
export async function speakerUserIds(eventId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("event_speakers")
    .select("user_id")
    .eq("event_id", eventId)
    .not("user_id", "is", null)
    .limit(20);
  if (error) {
    // A missing table means 0084 has not been run. Degrading to "there are no
    // guest speakers" keeps every existing webinar working exactly as it did,
    // which is the same call lib/live-rooms.ts makes about live_participants.
    if (!isMissingTable(error)) {
      console.error("[webinars] speaker id read failed", error.message);
    }
    return [];
  }
  return (data ?? []).map((r: any) => r.user_id).filter(Boolean);
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
    if (!isMissingTable(error)) {
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
  "id, event_id, author_id, body, is_host, approved_at, removed_at, pinned, created_at, " +
  "author:profiles!webinar_messages_author_id_fkey(full_name)";

/** PostgREST returns an embed as an object or a one-element array. */
function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function toChatMessage(row: any, readerId: string | null): ChatMessage {
  const author = one<any>(row.author);
  return {
    id: row.id,
    eventId: row.event_id,
    authorId: row.author_id,
    // "You" for your own, exactly as askQuestion echoes a question back. It
    // also means a room in `private` mode — where the only messages a viewer
    // can read are their own — never renders a name at all.
    authorName:
      readerId && row.author_id === readerId
        ? "You"
        : author?.full_name || "A student",
    body: row.body,
    isHost: !!row.is_host,
    approvedAt: row.approved_at ?? null,
    pinned: !!row.pinned,
    createdAt: row.created_at,
  };
}

/**
 * The room's chat, shaped by who is asking.
 *
 * `forModerator` is the whole of the privacy split, and it is passed in rather
 * than derived here for the reason given at the top of this file. A moderator
 * (staff host or guest speaker) gets everything including what is pending and
 * what was removed — that IS the moderation queue. Everybody else gets what the
 * room can see, plus their own pending messages, which they must keep seeing:
 * a student whose message vanished on send would reasonably conclude the room
 * is broken and send it again.
 *
 * `since` makes a bump cheap. The room re-reads from its last cursor rather
 * than re-reading the whole feed, so a busy room costs one small query per
 * message per client instead of one large one.
 */
export async function listChat({
  eventId,
  readerId,
  forModerator,
  since,
  limit = 200,
}: {
  eventId: string;
  readerId: string | null;
  forModerator: boolean;
  since?: string | null;
  limit?: number;
}): Promise<ChatMessage[]> {
  const admin = createAdminClient();
  let query = admin
    .from("webinar_messages")
    .select(CHAT_SELECT)
    .eq("event_id", eventId);

  if (!forModerator) {
    // Removed messages are gone for everyone but a moderator, including for
    // the person who wrote them — a host who takes a message down has taken it
    // down, and leaving it visible to its author invites them to send it again.
    query = query.is("removed_at", null);
    if (readerId) {
      // Approved, or mine. PostgREST's `or` takes a comma-separated filter
      // list; `approved_at.not.is.null` is its spelling of IS NOT NULL.
      query = query.or(`approved_at.not.is.null,author_id.eq.${readerId}`);
    } else {
      query = query.not("approved_at", "is", null);
    }
  }
  if (since) query = query.gt("created_at", since);

  const { data, error } = await query
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) {
    if (!isMissingTable(error)) {
      console.error("[webinars] chat read failed", error.message);
    }
    return [];
  }
  return (data ?? []).map((r) => toChatMessage(r, readerId));
}

/** The one message a host has pinned, if any. */
export async function pinnedMessage(
  eventId: string,
  readerId: string | null,
): Promise<ChatMessage | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("webinar_messages")
    .select(CHAT_SELECT)
    .eq("event_id", eventId)
    .eq("pinned", true)
    .is("removed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return toChatMessage(data, readerId);
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

/**
 * Polls for one event, with the tally and the reader's own vote.
 *
 * Three queries rather than one join, deliberately: a tally is a group-by that
 * PostgREST cannot express, and doing it in SQL would mean an RPC — a database
 * function to keep in step with a migration, for an aggregate over at most a
 * few hundred rows. Counting in JavaScript is the cheaper thing to own.
 *
 * `tally` is returned even when `results_visible` is false; the CALLER decides
 * whether to send it on. That split is on purpose — a host always sees the
 * numbers, and hiding them from the audience is a rendering decision made
 * where the role is known.
 */
export async function listPolls({
  eventId,
  readerId,
  forModerator,
}: {
  eventId: string;
  readerId: string | null;
  forModerator: boolean;
}): Promise<WebinarPoll[]> {
  const admin = createAdminClient();
  let pollQuery = admin
    .from("webinar_polls")
    .select(
      "id, event_id, question, options, open, results_visible, created_at",
    )
    .eq("event_id", eventId);
  // A draft poll is the host's private preparation. Showing one to the audience
  // before it opens would give away where the talk is going.
  if (!forModerator) pollQuery = pollQuery.eq("open", true);

  const { data: polls, error } = await pollQuery
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) {
    if (!isMissingTable(error)) {
      console.error("[webinars] poll read failed", error.message);
    }
    return [];
  }
  const rows = polls ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((p: any) => p.id);
  const { data: votes } = await admin
    .from("webinar_poll_votes")
    .select("poll_id, voter_id, choice")
    .in("poll_id", ids)
    .limit(5000);

  const tallies = new Map<string, number[]>();
  const mine = new Map<string, number>();
  for (const p of rows as any[]) {
    tallies.set(p.id, new Array(optionsOf(p).length).fill(0));
  }
  for (const v of (votes ?? []) as any[]) {
    const t = tallies.get(v.poll_id);
    // A choice outside the option range cannot be written (the RLS check bounds
    // it against jsonb_array_length) but a poll whose options were rewritten by
    // hand could strand one. Ignoring it beats an undefined++ that renders NaN.
    if (t && v.choice >= 0 && v.choice < t.length) t[v.choice] += 1;
    if (readerId && v.voter_id === readerId) mine.set(v.poll_id, v.choice);
  }

  return (rows as any[]).map((p) => ({
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
}

/** jsonb comes back parsed, but a hand-written row could hold anything. */
function optionsOf(row: any): string[] {
  const raw = row.options;
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => String(o));
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
 * `minutes` is last-seen minus joined, which over-counts someone who closed
 * their laptop mid-session by up to one heartbeat interval and under-counts
 * nobody. That asymmetry is the right one for an attendance figure: the error
 * is bounded, it is in the student's favour, and the alternative — summing
 * heartbeat gaps — would need a row per beat.
 */
export async function listAttendance(
  eventId: string,
): Promise<AttendanceRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("live_participants")
    .select(
      "user_id, role, display_name, joined_at, last_seen_at, left_at, " +
        "profile:profiles!live_participants_user_id_fkey(email)",
    )
    .eq("event_id", eventId)
    .order("joined_at", { ascending: true })
    .limit(1000);
  if (error) {
    if (!isMissingTable(error)) {
      console.error("[webinars] attendance read failed", error.message);
    }
    return [];
  }
  return (data ?? []).map((r: any) => {
    const end = new Date(r.left_at ?? r.last_seen_at).getTime();
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

/**
 * Is this the "0084 hasn't been run yet" error rather than a real failure?
 *
 * The same shape as `isMissingTable` in lib/live-rooms.ts, and it exists for
 * the same reason: a deploy can reach production before the SQL is applied by
 * hand in the Supabase editor, and when it does, every webinar must degrade to
 * "the new panels are empty" rather than to "nobody can join". PostgREST
 * reports an unknown table as PGRST205 and Postgres as 42P01; both are checked
 * because the message text is not a stable contract.
 */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "PGRST205" ||
    error.code === "42P01" ||
    /does not exist|schema cache/i.test(error.message ?? "")
  );
}
