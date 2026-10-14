/**
 * Office hours that were booked before the feature was retired (October
 * 2026) and haven't happened yet.
 *
 * The pages and their writes are gone, but a session booked before the deploy
 * still stands: its time and Zoom link live only on mentor_slots. Until the
 * last one has passed, the student's /dashboard/calls and the mentor's
 * /mentor/calls list theirs (lib/office-hours-server.ts reads them); after
 * that the list renders nothing. Pure and import-free but for the link check,
 * so `node --test` runs it (lib/office-hours.test.ts).
 */
import { safeHttpsUrl } from "./google-drive-links.ts";

export type OfficeHoursSlotRow = {
  id: string;
  mentor_id: string;
  starts_at: string;
  ends_at: string;
  zoom_url: string | null;
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
  /** Only an https link survives; anything else is dropped, not rendered. */
  joinUrl: string | null;
  topic: string | null;
  /** The other person: the mentor for a student, the student for a mentor. */
  withName: string;
};

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
    out.push({
      id: b.id,
      startsAt: slot.starts_at,
      endsAt: slot.ends_at,
      joinUrl: safeHttpsUrl(slot.zoom_url),
      topic: b.topic?.trim() || null,
      withName: names.get(otherId) ?? (side === "student" ? "your mentor" : "a student"),
    });
  }
  return out.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}
