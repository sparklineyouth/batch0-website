/**
 * The student home's "Needs you" list — pure picking rules. Relative .ts
 * imports so `node --test` runs it without a bundler.
 *
 * Both homes read it: /dashboard (one "Needs you" list) and the installed
 * app's /app/home ("This week" and "Next up"). They used to pick on their own,
 * and the phone took the first three owed items off an oldest-first list, so
 * three weeks of missed work hid what was due today, and it never showed the
 * student's 1:1 at all. homeNeeds() is the one answer both now lay out.
 */
import { studentEventStatus } from "./event-form.ts";
import { callListPhase, isPastPhase, isRoomOpenPhase, type CallTiming } from "./call-lifecycle.ts";
import { studentGroup, type DerivedStatus } from "./assignments.ts";

/** The `events` columns the home reads. All predate 0093–0100. */
export const HOME_EVENT_COLUMNS =
  "id, title, starts_at, ends_at, live_mode, zoom_url, live_started_at, live_ended_at";

export type HomeEventRow = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  live_mode: string | null;
  zoom_url: string | null;
  live_started_at: string | null;
  live_ended_at: string | null;
};

export type NextEvent<T extends HomeEventRow = HomeEventRow> = {
  id: string;
  title: string;
  startsAt: string;
  live: boolean;
  /** Where the row goes when there's nothing to join yet. */
  href: string;
  /** Set once the room (or the external link) is open. */
  join: { href: string; external: boolean } | null;
  /** The row it came from, for what a surface shows beside the title. */
  row: T;
};

type EventOpts = {
  preCohort: boolean;
  /** The events list a not-yet-open row links to: each surface has its own. */
  eventsHref?: string;
};

function isHosted(mode: string | null): boolean {
  return mode === "hosted" || mode === "premiere";
}

function httpsUrl(url: string | null): string | null {
  const u = (url ?? "").trim();
  return /^https:\/\/\S+$/i.test(u) ? u : null;
}

/**
 * The next events worth showing, at most `limit`: running ones first, else
 * the soonest ahead. Pre-cohort students can't open the events list, only a
 * hosted room, so they're shown hosted events only, linked to the room.
 */
export function pickNextEvents<T extends HomeEventRow>(
  rows: readonly T[],
  now: Date,
  opts: EventOpts,
  limit: number,
): NextEvent<T>[] {
  const eventsHref = opts.eventsHref ?? "/dashboard/events";
  return rows
    .filter((e) => !opts.preCohort || isHosted(e.live_mode))
    .map((e) => ({
      e,
      status: studentEventStatus(
        {
          startsAt: e.starts_at,
          endsAt: e.ends_at,
          liveStartedAt: e.live_started_at,
          liveEndedAt: e.live_ended_at,
        },
        now,
      ),
    }))
    .filter((x) => x.status === "live" || x.status === "open" || x.status === "upcoming")
    .sort(
      (a, b) =>
        Number(b.status === "live") - Number(a.status === "live") ||
        Date.parse(a.e.starts_at) - Date.parse(b.e.starts_at),
    )
    .slice(0, Math.max(0, limit))
    .map(({ e, status }) => {
      const room = `/dashboard/events/${e.id}/live`;
      const hosted = isHosted(e.live_mode);
      const open = status === "live" || status === "open";
      const external = hosted ? null : httpsUrl(e.zoom_url);
      return {
        id: e.id,
        title: e.title,
        startsAt: e.starts_at,
        live: status === "live",
        href: hosted && opts.preCohort ? room : eventsHref,
        join: !open
          ? null
          : hosted
            ? { href: room, external: false }
            : external
              ? { href: external, external: true }
              : null,
        row: e,
      };
    });
}

/** The single next event: pickNextEvents' first. */
export function pickNextEvent<T extends HomeEventRow>(
  rows: readonly T[],
  now: Date,
  opts: EventOpts,
): NextEvent<T> | null {
  return pickNextEvents(rows, now, opts, 1)[0] ?? null;
}

/**
 * The student's next 1:1: one whose room is open first, else the soonest
 * still ahead. Phases are the student side's, as the calls list reads them.
 */
export function pickNextCall<T extends CallTiming & { id: string }>(
  invites: readonly T[],
  now: Date,
): { invite: T; joinable: boolean } | null {
  const ahead = invites
    .map((invite) => ({ invite, phase: callListPhase(invite, now, "student") }))
    .filter((x) => !isPastPhase(x.phase))
    .sort(
      (a, b) =>
        Number(isRoomOpenPhase(b.phase)) - Number(isRoomOpenPhase(a.phase)) ||
        Date.parse(a.invite.startsAt) - Date.parse(b.invite.startsAt),
    );
  const first = ahead[0];
  return first ? { invite: first.invite, joinable: isRoomOpenPhase(first.phase) } : null;
}

/**
 * Where an owed item ranks on the home: sent back first, then due today, then
 * the rest of the week in due order, and late work last (newest first). A
 * student with a few weeks of missed work still sees what is due tomorrow.
 */
function dueRank(status: DerivedStatus): number {
  if (status === "returned") return 0;
  if (status === "due_today") return 1;
  if (status === "missing") return 3;
  return 2;
}

function dueTime(dueAt: string | null): number {
  const t = dueAt ? Date.parse(dueAt) : NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/**
 * Work the student owes soon (late, sent back, due today, or due within 7
 * days), ranked by dueRank, at most `limit`. `more` counts what was cut, so
 * the home can link the rest.
 */
export function dueSoon<T extends { status: DerivedStatus; assignment: { due_at: string | null } }>(
  items: readonly T[],
  now: Date,
  limit = 3,
): { items: T[]; more: number } {
  const due = items
    .filter((i) => studentGroup(i.status, i.assignment.due_at, now) === "due")
    .map((i, index) => ({ i, index, rank: dueRank(i.status), at: dueTime(i.assignment.due_at) }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.rank === 3 ? b.at - a.at : a.at - b.at) ||
        a.index - b.index,
    )
    .map((x) => x.i);
  return { items: due.slice(0, limit), more: Math.max(0, due.length - limit) };
}

/** The row that stands in for what dueSoon cut: "2 more assignments due". */
export function moreDueLabel(more: number): string {
  return `${more} more assignment${more === 1 ? "" : "s"} due`;
}

/** Something on the calendar a home lists: a 1:1 or an event. */
export type NextUpItem<C, E extends HomeEventRow = HomeEventRow> =
  | { kind: "call"; key: string; at: string; call: { invite: C; joinable: boolean } }
  | { kind: "event"; key: string; at: string; event: NextEvent<E> };

export type HomeNeeds<I, C, E extends HomeEventRow = HomeEventRow> = {
  /** Owed work, ranked (dueSoon): at most `dueLimit`, `more` for the rest. */
  due: { items: I[]; more: number };
  /** Rooms open right now: the 1:1 first (one person is waiting), then events. */
  open: NextUpItem<C, E>[];
  /** Not open yet, soonest first. */
  later: NextUpItem<C, E>[];
};

/**
 * Everything both homes list, decided once.
 *
 * Owed work exists only for a student whose cohort has started: before
 * kickoff the assignments page is locked (lib/pre-cohort.ts), and a row there
 * would bounce them home. The 1:1 is anyone's: the team books calls with
 * applicants and pre-cohort students too, and /dashboard/calls is open to
 * both. Which events are passed in is the caller's read (RLS, or the app's
 * cohort-scoped cache); `preCohort` narrows them to hosted rooms.
 *
 * The desktop lays it out as open → due → later in one list; the phone puts
 * `due` under "This week" and open + later under "Next up". Same items, same
 * order, so the two never disagree about what matters.
 */
export function homeNeeds<
  I extends { status: DerivedStatus; assignment: { due_at: string | null } },
  C extends CallTiming & { id: string },
  E extends HomeEventRow,
>(input: {
  access: { enrolled: boolean; preCohort: boolean };
  assignments: readonly I[];
  events: readonly E[];
  calls: readonly C[];
  now: Date;
  /** How many calendar events to list. The desktop shows one, the phone two. */
  eventLimit?: number;
  dueLimit?: number;
  eventsHref?: string;
}): HomeNeeds<I, C, E> {
  const { access, now } = input;
  const due =
    access.enrolled && !access.preCohort
      ? dueSoon(input.assignments, now, input.dueLimit ?? 3)
      : { items: [] as I[], more: 0 };
  const events = pickNextEvents(
    input.events,
    now,
    { preCohort: access.preCohort, eventsHref: input.eventsHref },
    input.eventLimit ?? 1,
  );
  const call = pickNextCall(input.calls, now);

  const open: NextUpItem<C, E>[] = [];
  const later: NextUpItem<C, E>[] = [];
  if (call) {
    const item: NextUpItem<C, E> = {
      kind: "call",
      key: `call-${call.invite.id}`,
      at: call.invite.startsAt,
      call,
    };
    (call.joinable ? open : later).push(item);
  }
  for (const event of events) {
    const item: NextUpItem<C, E> = {
      kind: "event",
      key: `event-${event.id}`,
      at: event.startsAt,
      event,
    };
    (event.join ? open : later).push(item);
  }
  // Stable sort: on a tie the call (pushed first) stays ahead.
  later.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { due, open, later };
}
