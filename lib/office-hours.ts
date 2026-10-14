/**
 * Office hours that were booked before the feature was retired (October
 * 2026) and haven't happened yet.
 *
 * The pages and their writes are gone, but a session booked before the deploy
 * still stands: its time, meeting link and the mentor's notes live only on
 * mentor_slots. Until the last one has passed, the student's /dashboard/calls
 * and the mentor's /mentor/calls list theirs (lib/office-hours-server.ts reads
 * them; a mentor-panel role without calls.invite sees its own on /mentor);
 * after that the list renders nothing. Pure and import-free but for the link
 * check, so `node --test` runs it (lib/office-hours.test.ts).
 */
import { safeHttpsUrl } from "./google-drive-links.ts";

export type OfficeHoursSlotRow = {
  id: string;
  mentor_id: string;
  starts_at: string;
  ends_at: string;
  zoom_url: string | null;
  notes: string | null;
};

export type OfficeHoursBookingRow = {
  id: string;
  slot_id: string;
  student_id: string;
  topic: string | null;
  status: string;
};

export type OfficeHoursSession = {
  id: string;
  startsAt: string;
  endsAt: string;
  /** Only an https link is ever a link. */
  joinUrl: string | null;
  /**
   * The slot's meeting field when it isn't an https link. The old form took
   * any text ("zoom.us/j/1", a Discord channel), so it is shown as plain
   * text, never linked.
   */
  meetingText: string | null;
  /** What the mentor wrote on the slot: how to join, what to bring. */
  notes: string | null;
  topic: string | null;
  /** The other person: the mentor for a student, the student for a mentor. */
  withName: string;
};

// The old form capped notes at 280; the column itself has no limit.
const MAX_NOTES = 500;
const MAX_MEETING_TEXT = 300;

/** Trimmed, null when blank, cut to `max` characters. */
function clip(raw: string | null | undefined, max: number): string | null {
  const s = raw?.trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Booked sessions that haven't ended, soonest first. `side` says whose list
 * this is, and so whose name goes in `withName`.
 */
export function upcomingOfficeHours(
  side: "student" | "mentor",
  bookings: OfficeHoursBookingRow[],
  slots: OfficeHoursSlotRow[],
  names: Map<string, string>,
  now: Date,
): OfficeHoursSession[] {
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const out: OfficeHoursSession[] = [];
  for (const b of bookings) {
    if (b.status !== "booked") continue;
    const slot = slotById.get(b.slot_id);
    if (!slot || new Date(slot.ends_at).getTime() <= now.getTime()) continue;
    const otherId = side === "student" ? slot.mentor_id : b.student_id;
    const joinUrl = safeHttpsUrl(slot.zoom_url);
    out.push({
      id: b.id,
      startsAt: slot.starts_at,
      endsAt: slot.ends_at,
      joinUrl,
      meetingText: joinUrl ? null : clip(slot.zoom_url, MAX_MEETING_TEXT),
      notes: clip(slot.notes, MAX_NOTES),
      topic: b.topic?.trim() || null,
      withName: names.get(otherId) ?? (side === "student" ? "your mentor" : "a student"),
    });
  }
  return out.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}
