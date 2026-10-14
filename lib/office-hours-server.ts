import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  upcomingOfficeHours,
  type OfficeHoursBookingRow,
  type OfficeHoursSession,
  type OfficeHoursSlotRow,
} from "@/lib/office-hours";

/**
 * The caller's own office-hours sessions that were booked before the feature
 * was retired and haven't ended (lib/office-hours.ts). Service role with
 * explicit filters on `userId`: a student sees bookings they made, a mentor
 * the bookings on their own slots. Any failed read is an empty list.
 */
export async function loadUpcomingOfficeHours(
  side: "student" | "mentor",
  userId: string,
  now = new Date(),
): Promise<OfficeHoursSession[]> {
  const admin = createAdminClient();
  const nowIso = now.toISOString();
  try {
    let bookings: OfficeHoursBookingRow[] = [];
    let slots: OfficeHoursSlotRow[] = [];
    if (side === "student") {
      const { data: b } = await admin
        .from("mentor_bookings")
        .select("id, slot_id, student_id, topic, status")
        .eq("student_id", userId)
        .eq("status", "booked");
      bookings = (b ?? []) as OfficeHoursBookingRow[];
      if (bookings.length === 0) return [];
      const { data: s } = await admin
        .from("mentor_slots")
        .select("id, mentor_id, starts_at, ends_at, zoom_url")
        .in("id", bookings.map((r) => r.slot_id))
        .gt("ends_at", nowIso);
      slots = (s ?? []) as OfficeHoursSlotRow[];
    } else {
      const { data: s } = await admin
        .from("mentor_slots")
        .select("id, mentor_id, starts_at, ends_at, zoom_url")
        .eq("mentor_id", userId)
        .gt("ends_at", nowIso);
      slots = (s ?? []) as OfficeHoursSlotRow[];
      if (slots.length === 0) return [];
      const { data: b } = await admin
        .from("mentor_bookings")
        .select("id, slot_id, student_id, topic, status")
        .in("slot_id", slots.map((r) => r.id))
        .eq("status", "booked");
      bookings = (b ?? []) as OfficeHoursBookingRow[];
    }
    if (bookings.length === 0 || slots.length === 0) return [];

    const otherIds = Array.from(
      new Set(side === "student" ? slots.map((s) => s.mentor_id) : bookings.map((b) => b.student_id)),
    );
    // Names only, never emails: the other side of a booking is someone the
    // viewer may not otherwise be allowed to contact directly.
    const { data: people } = await admin
      .from("profiles")
      .select("id, full_name")
      .in("id", otherIds);
    const names = new Map<string, string>();
    for (const p of (people ?? []) as { id: string; full_name: string | null }[]) {
      const name = p.full_name?.trim();
      if (name) names.set(p.id, name);
    }
    return upcomingOfficeHours(side, bookings, slots, names, now);
  } catch (err) {
    console.error("[office-hours] load failed", err);
    return [];
  }
}
