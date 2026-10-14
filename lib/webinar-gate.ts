import "server-only";
import { roomIsOpen, webinarHasBegun, type RoomAccess } from "@/lib/live";
import {
  canEndForEveryone,
  isHostedOnBatch0,
  type AudienceMode,
} from "@/lib/webinars";
import {
  presentHostRoles,
  resolveEventAccess,
  roomAccessFor,
  withinHardClose,
  type EventAccess,
} from "@/lib/live-access";

/**
 * Who may do what in a webinar room, for the room's server actions and the
 * panel read route. Built on `resolveEventAccess`, the same resolution the
 * page and joinRoom use, so "who is a host" has one answer everywhere.
 */
export type RoomGate = {
  eventId: string;
  startsAt: string;
  endsAt: string | null;
  audienceMode: AudienceMode;
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  userId: string;
  /** Staff with `events.manage`, or a guest speaker on THIS event. */
  isModerator: boolean;
  /** Staff only. A guest speaker may moderate without being able to schedule. */
  isStaff: boolean;
  /** A claimed guest speaker (never also staff). */
  isSpeaker: boolean;
  /** False for a guest speaker: never told who is in the audience. */
  discloseNames: boolean;
  /** The caller's roomAccess right now (host window for moderators). */
  access: RoomAccess;
};

export async function gateFromAccess(access: EventAccess): Promise<RoomGate | null> {
  if (!isHostedOnBatch0(access.event.liveMode)) return null;
  const ev = access.event;
  return {
    eventId: ev.id,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    audienceMode: ev.audienceMode,
    liveStartedAt: ev.liveStartedAt,
    liveEndedAt: ev.liveEndedAt,
    userId: access.userId,
    isModerator: access.isHost,
    isStaff: access.isStaff,
    isSpeaker: access.isSpeaker,
    discloseNames: access.discloseNames,
    access: await roomAccessFor(access),
  };
}

/**
 * Role and visibility, NO window — for End and Reopen, which must work while
 * an overrunning room is still up (they bound themselves by the hard stop).
 *
 * Null for "can't see it" and "not a batch0 room" alike, so it cannot probe
 * which events exist. `throwOnError` turns a failed read into a throw for a
 * caller whose client reads null as a real answer.
 */
export async function gateVisible(
  eventId: string,
  opts?: { throwOnError?: boolean },
): Promise<RoomGate | null> {
  const access = await resolveEventAccess(eventId);
  if (!access.ok) {
    if (access.reason === "error" && opts?.throwOnError) {
      throw new Error("Couldn't reach the server — try again.");
    }
    return null;
  }
  return gateFromAccess(access);
}

/**
 * Role, visibility AND the caller's window: the gate for every panel read and
 * write. A viewer is also let through after End (up to the hard stop) so the
 * panel can still be read; every audience write refuses once ended.
 */
export async function gateRoom(
  eventId: string,
  opts?: { throwOnError?: boolean },
): Promise<RoomGate | null> {
  const gate = await gateVisible(eventId, opts);
  if (!gate) return null;
  if (roomIsOpen(gate.access)) return gate;
  if (gate.access === "ended" && withinHardClose(gate)) return gate;
  return null;
}

/** Is the room closed to this caller's writes (ended, and not a host)? */
export function endedForAudience(gate: RoomGate): boolean {
  return !!gate.liveEndedAt && !gate.isModerator;
}

/**
 * May the caller end this webinar for everyone, right now? Never before it
 * has begun; then staff always, a guest speaker only with no staff host
 * present (an unreadable attendance table counts as none — ending is
 * reversible by staff, stranding a guest-only room is not).
 */
export async function canEnd(gate: RoomGate): Promise<boolean> {
  if (!webinarHasBegun(gate.startsAt, gate.liveStartedAt)) return false;
  if (gate.isStaff) return true;
  if (!gate.isSpeaker) return false;
  const hosts = await presentHostRoles(gate.eventId);
  const staffPresent =
    !!hosts && hosts.some((h) => h.isStaff && h.userId !== gate.userId);
  return canEndForEveryone({ isStaff: false, isSpeaker: true, staffPresent });
}
