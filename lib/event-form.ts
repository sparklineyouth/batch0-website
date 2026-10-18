/**
 * Rules for the admin event form and the events list. Pure: the browser form,
 * the server actions and lib/event-form.test.ts all read the same rules.
 *
 * Relative .ts import so `node --test` can load it without a bundler.
 */
import { eventLiveStatus, roomAccess, roomIsOpen, roomWindow } from "./live.ts";

export const EVENT_TYPES = [
  "webinar",
  "workshop",
  "office_hours",
  "demo_day",
  "other",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  webinar: "Webinar",
  workshop: "Workshop",
  office_hours: "Office hours",
  demo_day: "Demo Day",
  other: "Other",
};

export function isEventType(value: unknown): value is EventType {
  return (EVENT_TYPES as readonly unknown[]).includes(value);
}

export const EVENT_DURATIONS = [30, 45, 60, 90, 120] as const;
export const DEFAULT_DURATION_MINUTES = 60;
/** Bounds the server accepts for a duration (a custom length on an old row). */
export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 12 * 60;
export const MAX_TITLE_LENGTH = 200;
export const DEFAULT_LIVE_TITLE = "Live session";

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO → `datetime-local` value in the runtime's own zone. "" for nothing. */
export function toLocalInput(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value → ISO, or null when empty or unparseable. */
export function fromLocalInput(local: string | null | undefined): string | null {
  if (!local || !local.trim()) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The next whole hour after `now` (14:20 → 15:00, 14:00 → 15:00). */
export function nextRoundHour(now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

export function floorToMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / MINUTE) * MINUTE);
}

export function endsAtFor(startsAtIso: string, minutes: number): string {
  return new Date(new Date(startsAtIso).getTime() + minutes * MINUTE).toISOString();
}

/** A saved event's length in minutes. No end means the default hour. */
export function durationOf(
  startsAt: string,
  endsAt: string | null | undefined,
): number {
  if (!endsAt) return DEFAULT_DURATION_MINUTES;
  const mins = Math.round(
    (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / MINUTE,
  );
  return Number.isFinite(mins) && mins > 0 ? mins : DEFAULT_DURATION_MINUTES;
}

/** The standard lengths, plus `current` when an older row has another one. */
export function durationOptions(current: number): number[] {
  const all = new Set<number>([...EVENT_DURATIONS, current]);
  return [...all].sort((a, b) => a - b);
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * An admin-typed link: empty → null, http(s) → the normalised URL, anything
 * else (javascript:, mailto:, a bare word) → invalid. It ends up in an href
 * in email and on student pages, so only the two web schemes pass.
 */
export function parseHttpUrl(
  input: string | null | undefined,
): { ok: true; url: string | null } | { ok: false } {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: true, url: null };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false };
  if (!u.hostname) return { ok: false };
  return { ok: true, url: u.toString() };
}

/**
 * A stored event link (zoom_url, recording_url) as an href, or null: https
 * only, with no whitespace, quote or angle bracket in it. The read-side half
 * of parseHttpUrl, for every page and email that turns one of those columns
 * into a link.
 *
 * The admin form checks what it saves, but the columns hold whatever was ever
 * written — by an older form, a SQL fix, an import — and a `javascript:` value
 * in an href runs in the reader's session the moment they tap "Join". The
 * student home has always read the link through this; the installed app's
 * Join button, the recording links and the Demo Day ticket used it raw. A
 * link that fails it shows as no link, as on the home. The quote and the
 * brackets: the ticket emails put the link inside href="…" with a text-only
 * escaper, and a URL the form saved has them percent-encoded anyway.
 */
export function httpsUrl(url: string | null | undefined): string | null {
  const u = (url ?? "").trim();
  return /^https:\/\/[^\s"<>]+$/i.test(u) ? u : null;
}

/** An event link the form may save: empty, or a link httpsUrl will show. */
function isSavableEventLink(input: string): boolean {
  const parsed = parseHttpUrl(input);
  return parsed.ok && (parsed.url === null || httpsUrl(parsed.url) !== null);
}

// ---------------------------------------------------------------------------
// Who can see it
// ---------------------------------------------------------------------------

/**
 * The form's single "Who" select, encoded as one string:
 *   "cohort:<id>"  enrolled students of that cohort
 *   "public"       everyone signed in
 *   "staff"        staff only (a rehearsal)
 *
 * "Enrolled" always carries a cohort: an enrolled event without one matches no
 * enrollment in the `events read` policy, so no student could ever see it.
 */
export type Who =
  | { kind: "cohort"; cohortId: string }
  | { kind: "public" }
  | { kind: "staff" };

export type Visibility = "enrolled" | "public" | "staff";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function parseWho(value: string | null | undefined): Who | null {
  if (value === "public") return { kind: "public" };
  if (value === "staff") return { kind: "staff" };
  if (value?.startsWith("cohort:")) {
    const id = value.slice("cohort:".length);
    return isUuid(id) ? { kind: "cohort", cohortId: id } : null;
  }
  return null;
}

/** Who → the select's value; parseWho reads it back. */
export function whoValue(who: Who): string {
  return who.kind === "cohort" ? `cohort:${who.cohortId}` : who.kind;
}

/** A cohort's option value in the Who select. */
export function cohortWho(cohortId: string): string {
  return whoValue({ kind: "cohort", cohortId });
}

/** A saved row → the select's value. A legacy cohort-less "enrolled" row
 *  falls back to `fallbackCohortId`, so saving it makes it visible. */
export function whoFromRow(
  row: { visibility: string; cohort_id: string | null },
  fallbackCohortId: string | null,
): string {
  if (row.visibility === "public") return "public";
  if (row.visibility === "staff") return "staff";
  const id = row.cohort_id ?? fallbackCohortId;
  return id ? cohortWho(id) : "public";
}

/**
 * Who → the two columns. Public and staff events keep the cohort they already
 * had (an edit must not silently drop an event off its cohort's timetable);
 * new ones get none.
 */
export function audienceFor(
  who: Who,
  existingCohortId: string | null,
): { visibility: Visibility; cohort_id: string | null } {
  if (who.kind === "cohort") {
    return { visibility: "enrolled", cohort_id: who.cohortId };
  }
  return { visibility: who.kind, cohort_id: existingCohortId };
}

export type CohortLite = {
  id: string;
  name?: string;
  startsOn: string | null;
  endsOn: string | null;
  status?: string | null;
};

/**
 * The cohort a new event is most likely for: the one running today, else the
 * next to start, else the most recent. Dates are `YYYY-MM-DD` strings.
 */
export function pickDefaultCohort(
  cohorts: readonly CohortLite[],
  now: Date = new Date(),
): string | null {
  const live = cohorts.filter((c) => c.status !== "cancelled");
  if (live.length === 0) return null;
  const today = now.toISOString().slice(0, 10);
  const running = live.find(
    (c) =>
      c.status === "active" ||
      (!!c.startsOn &&
        c.startsOn <= today &&
        (!c.endsOn || c.endsOn >= today) &&
        c.status !== "completed"),
  );
  if (running) return running.id;
  const next = live
    .filter((c) => !!c.startsOn && c.startsOn > today)
    .sort((a, b) => (a.startsOn! < b.startsOn! ? -1 : 1))[0];
  if (next) return next.id;
  const recent = [...live].sort((a, b) =>
    (a.startsOn ?? "") > (b.startsOn ?? "") ? -1 : 1,
  )[0];
  return recent?.id ?? null;
}

// ---------------------------------------------------------------------------
// Validation (the server's copy is the one that binds)
// ---------------------------------------------------------------------------

export type EventFieldErrors = Partial<
  Record<"title" | "startsAt" | "duration" | "externalUrl" | "recordingUrl" | "who", string>
>;

export function validateEventFields(d: {
  title: string;
  startsAt: string | null;
  durationMinutes: number;
  liveMode: "hosted" | "external";
  externalUrl: string;
  recordingUrl: string;
  who: string;
  /** An edited event's saved length: kept as is even outside the bounds
   *  (a two-day Demo Day stays editable without being shortened). */
  savedDurationMinutes?: number | null;
}): EventFieldErrors {
  const errors: EventFieldErrors = {};
  const title = d.title.trim();
  if (!title) errors.title = "Add a title.";
  else if (title.length > MAX_TITLE_LENGTH) errors.title = "Keep the title under 200 characters.";
  if (!d.startsAt || Number.isNaN(new Date(d.startsAt).getTime())) {
    errors.startsAt = "Pick a date and time.";
  }
  const unchanged =
    d.savedDurationMinutes != null && d.durationMinutes === d.savedDurationMinutes;
  if (
    !Number.isInteger(d.durationMinutes) ||
    d.durationMinutes <= 0 ||
    (!unchanged &&
      (d.durationMinutes < MIN_DURATION_MINUTES || d.durationMinutes > MAX_DURATION_MINUTES))
  ) {
    errors.duration = "Pick a length.";
  }
  // https only, though parseHttpUrl takes http too: every page reads these
  // links through httpsUrl, so an http one would save and then show nowhere.
  if (d.liveMode === "external" && !isSavableEventLink(d.externalUrl)) {
    errors.externalUrl = "Use a full https:// link.";
  }
  if (!isSavableEventLink(d.recordingUrl)) {
    errors.recordingUrl = "Use a full https:// link.";
  }
  if (!parseWho(d.who)) errors.who = "Pick who it's for.";
  return errors;
}

// ---------------------------------------------------------------------------
// The admin list
// ---------------------------------------------------------------------------

export type AdminGroup = "live" | "upcoming" | "past";

type Timing = {
  startsAt: string;
  endsAt: string | null;
  liveStartedAt: string | null;
  liveEndedAt: string | null;
};

/**
 * Which section an event sits in on /admin/events.
 *
 * Live: a host is on air, a host went live and nobody ended it (the room is
 * still open), or the scheduled time is running. Ended, or past the room's
 * hard close, is Past.
 */
export function adminGroup(
  e: Timing,
  now: Date,
  hostOnAir: boolean,
): AdminGroup {
  if (e.liveEndedAt) return "past";
  const t = now.getTime();
  if (t > roomWindow(e.startsAt, e.endsAt).hardCloseAt) return "past";
  if (hostOnAir) return "live";
  if (e.liveStartedAt && new Date(e.liveStartedAt).getTime() <= t) return "live";
  const s = eventLiveStatus(
    { startsAt: e.startsAt, endsAt: e.endsAt, liveEndedAt: null },
    now,
  );
  if (s === "live") return "live";
  if (s === "past") return "past";
  return "upcoming";
}

/**
 * The room button on a hosted row: Join when a host is already on air, Start
 * when the room is live or about to be with nobody hosting, Open room before
 * that while hosts may already go in (lib/live.ts decides how early). Past
 * rows, and rows whose host window hasn't opened, get none.
 */
export function roomActionLabel(
  group: AdminGroup,
  hostOnAir: boolean,
  e: Timing,
  now: Date,
): "Join" | "Start" | "Open room" | null {
  if (group === "past") return null;
  if (hostOnAir) return "Join";
  if (group === "live") return "Start";
  const s = eventLiveStatus(
    { startsAt: e.startsAt, endsAt: e.endsAt, liveEndedAt: null },
    now,
  );
  if (s === "open") return "Start";
  const hostWindow = roomAccess({
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    liveEndedAt: null,
    isHost: true,
    hostPresent: false,
    now,
  });
  return roomIsOpen(hostWindow) ? "Open room" : null;
}

/**
 * live_started_at / live_ended_at / assets_shared_at describe one run of an
 * event. A run's stamps never predate its go-live window (lib/live.ts
 * roomWindow().goLiveOpensAt, the bound claimStage stamps from), so an older
 * one belongs to an earlier run — a reschedule or a reused row — and is
 * cleared on save so the event doesn't open as "Ended" or already shared.
 */
export const RUN_STAMPS = ["live_started_at", "live_ended_at", "assets_shared_at"] as const;
export type RunStamp = (typeof RUN_STAMPS)[number];

export function staleRunStamps(
  prior: Partial<Record<RunStamp, string | null>>,
  startsAtIso: string,
): Partial<Record<RunStamp, null>> {
  const runOpensAt = roomWindow(startsAtIso, null).goLiveOpensAt;
  const out: Partial<Record<RunStamp, null>> = {};
  for (const col of RUN_STAMPS) {
    const at = prior[col];
    if (at && new Date(at).getTime() < runOpensAt) out[col] = null;
  }
  return out;
}

/**
 * "Go live now" (staff, from the room) before the go-live window: the run
 * starts now, so the event moves to this minute and keeps its length. Its
 * stamp then sits inside the run's own window, which End, the follow-up,
 * the lists and a later edit (staleRunStamps) all assume, and the schedule
 * says when it really happened. Null inside the window, where a host's
 * arrival stamps the event as scheduled (shouldStampLiveStart).
 */
export function earlyStartSchedule(
  startsAt: string,
  endsAt: string | null,
  now: Date,
): { startsAt: string; endsAt: string } | null {
  const w = roomWindow(startsAt, endsAt);
  if (now.getTime() >= w.goLiveOpensAt) return null;
  const start = floorToMinute(now).getTime();
  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + (w.end - w.start)).toISOString(),
  };
}

/**
 * Who Go live now tells that the webinar is live, as the room's confirm says
 * it before anyone is told. Mirrors announceLive's recipients
 * (app/admin/events/notify.ts recipientsFor): the students of its cohort; for
 * "everyone signed in" with no cohort, those of every upcoming and active
 * cohort; nobody for a staff-only event or a (legacy) cohort-less enrolled one.
 */
export function goLiveNowAudience(ev: {
  visibility: string;
  cohortId: string | null;
  cohortName?: string | null;
}): string {
  if (ev.visibility === "staff") return "It's staff-only, so nobody is notified.";
  if (ev.cohortId) {
    const name = ev.cohortName?.trim();
    return `${name ? `Everyone in ${name}` : "Everyone in its cohort"} gets a notification and an email.`;
  }
  if (ev.visibility === "public") {
    return "Students in every upcoming and active cohort get a notification and an email.";
  }
  return "Nobody is notified: it has no cohort.";
}

/**
 * A student's view of an event: the list status (lib/live.ts eventLiveStatus,
 * which opens early once a host has gone live and closes with the viewer
 * window, like roomAccess), shown as "live" while a host is on air early.
 */
export function studentEventStatus(
  e: Timing,
  now: Date,
): "upcoming" | "open" | "live" | "ended" | "past" {
  const s = eventLiveStatus(
    {
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      liveStartedAt: e.liveStartedAt,
      liveEndedAt: e.liveEndedAt,
    },
    now,
  );
  if (
    s === "open" &&
    e.liveStartedAt &&
    new Date(e.liveStartedAt).getTime() <= now.getTime()
  ) {
    return "live";
  }
  return s;
}

// ---------------------------------------------------------------------------
// Notices and "Start a webinar now"
// ---------------------------------------------------------------------------

/**
 * Where an event notice (the bell and the email button) sends one student,
 * or null to leave them out. A student whose cohort hasn't started is locked
 * out of the events list (pre-cohort lockdown) but may open a hosted event's
 * room, so they hear about hosted events only, linked to the room.
 */
export function eventNoticeLink(
  ev: { id: string; hosted: boolean },
  kind: "posted" | "live",
  preCohort: boolean,
): string | null {
  const room = `/dashboard/events/${ev.id}/live`;
  if (ev.hosted && (kind === "live" || preCohort)) return room;
  return preCohort ? null : "/dashboard/events";
}

type LiveCandidate = Timing & {
  id: string;
  title: string;
  visibility: string;
  cohortId: string | null;
  liveMode: string | null;
};

/**
 * A hosted event live right now (adminGroup) for this audience — the same
 * cohort, or both "everyone", or both staff-only — so a second "Start a
 * webinar now" can point at it instead of opening a parallel room and
 * notifying everyone twice.
 */
export function liveForAudience<T extends LiveCandidate>(
  rows: readonly T[],
  audience: { visibility: Visibility; cohort_id: string | null },
  now: Date,
): T | null {
  return (
    rows.find(
      (r) =>
        (r.liveMode === "hosted" || r.liveMode === "premiere") &&
        r.visibility === audience.visibility &&
        (audience.visibility !== "enrolled" || r.cohortId === audience.cohort_id) &&
        adminGroup(r, now, false) === "live",
    ) ?? null
  );
}
