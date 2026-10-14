/**
 * The student home's "Needs you" list — pure picking rules. Relative .ts
 * imports so `node --test` runs it without a bundler.
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

export type NextEvent = {
  id: string;
  title: string;
  startsAt: string;
  live: boolean;
  /** Where the row goes when there's nothing to join yet. */
  href: string;
  /** Set once the room (or the external link) is open. */
  join: { href: string; external: boolean } | null;
};

function isHosted(mode: string | null): boolean {
  return mode === "hosted" || mode === "premiere";
}

function httpsUrl(url: string | null): string | null {
  const u = (url ?? "").trim();
  return /^https:\/\/\S+$/i.test(u) ? u : null;
}

/**
 * The next event worth showing: a running one first, else the soonest ahead.
 * Pre-cohort students can't open the events list, only a hosted room, so
 * they're shown hosted events only, linked to the room.
 */
export function pickNextEvent(
  rows: readonly HomeEventRow[],
  now: Date,
  opts: { preCohort: boolean },
): NextEvent | null {
  const candidates = rows
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
    );
  const first = candidates[0];
  if (!first) return null;
  const { e, status } = first;
  const room = `/dashboard/events/${e.id}/live`;
  const hosted = isHosted(e.live_mode);
  const open = status === "live" || status === "open";
  const external = hosted ? null : httpsUrl(e.zoom_url);
  return {
    id: e.id,
    title: e.title,
    startsAt: e.starts_at,
    live: status === "live",
    href: hosted && opts.preCohort ? room : "/dashboard/events",
    join: !open
      ? null
      : hosted
        ? { href: room, external: false }
        : external
          ? { href: external, external: true }
          : null,
  };
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

/** Work the student owes soon (late, sent back, due today, or due within 7 days). */
export function dueSoon<T extends { status: DerivedStatus; assignment: { due_at: string | null } }>(
  items: readonly T[],
  now: Date,
  limit = 3,
): T[] {
  return items.filter((i) => studentGroup(i.status, i.assignment.due_at, now) === "due").slice(0, limit);
}
