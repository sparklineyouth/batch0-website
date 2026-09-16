"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf, assertStaff } from "@/lib/server-guards";
import { notify } from "@/lib/notifications";

// The three mentor-side mutations below gate on assertStaff(), i.e. on the
// `mentor.panel` permission — the same key app/mentor/layout.tsx uses to let
// the page render. Gating the writes on the `mentor`/`admin` role slugs
// instead meant every button on a page a custom role could legitimately open
// threw "Forbidden". bookSlot and cancelBooking stay on assertSelf: they
// authorise on row ownership, not on staff status.

export async function createSlot(input: {
  startsAt: string;
  endsAt: string;
  zoomUrl?: string;
  notes?: string;
}) {
  const { userId } = await assertStaff();

  const starts = new Date(input.startsAt);
  const ends = new Date(input.endsAt);
  if (isNaN(starts.getTime()) || isNaN(ends.getTime())) {
    throw new Error("Invalid date.");
  }
  if (ends <= starts) throw new Error("End time must be after start.");
  if (starts.getTime() < Date.now() - 5 * 60 * 1000) {
    throw new Error("Slot starts in the past.");
  }

  const admin = createAdminClient();
  const { error } = await admin.from("mentor_slots").insert({
    mentor_id: userId,
    starts_at: starts.toISOString(),
    ends_at: ends.toISOString(),
    zoom_url: input.zoomUrl?.trim() || null,
    notes: input.notes?.trim().slice(0, 280) || null,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/mentor/office-hours");
  revalidatePath("/dashboard/office-hours");
}

export async function deleteSlot(input: { slotId: string }) {
  const { userId } = await assertStaff();
  const admin = createAdminClient();
  const { data: slot } = await admin
    .from("mentor_slots")
    .select("mentor_id")
    .eq("id", input.slotId)
    .single();
  if (!slot) throw new Error("Not found");
  if (slot.mentor_id !== userId) throw new Error("Forbidden");
  const { error } = await admin
    .from("mentor_slots")
    .delete()
    .eq("id", input.slotId);
  if (error) throw new Error(error.message);
  revalidatePath("/mentor/office-hours");
  revalidatePath("/dashboard/office-hours");
}

// Student claims a slot.
export async function bookSlot(input: { slotId: string; topic?: string }) {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { data: slot } = await admin
    .from("mentor_slots")
    .select("id, mentor_id, starts_at")
    .eq("id", input.slotId)
    .maybeSingle();
  if (!slot) throw new Error("Slot no longer exists.");
  if (new Date(slot.starts_at).getTime() < Date.now()) {
    throw new Error("That slot has already started.");
  }
  // Already booked?
  const { data: existing } = await admin
    .from("mentor_bookings")
    .select("id")
    .eq("slot_id", slot.id)
    .maybeSingle();
  if (existing) throw new Error("That slot is already taken.");

  const { error } = await admin.from("mentor_bookings").insert({
    slot_id: slot.id,
    student_id: userId,
    topic: input.topic?.trim().slice(0, 280) || null,
    status: "booked",
  });
  if (error) throw new Error(error.message);

  try {
    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, email")
      .eq("id", userId)
      .maybeSingle();
    const who = profile?.full_name ?? profile?.email ?? "A student";
    // Notification body bakes at creation time and we don't know the
    // recipient's timezone. Keep it short and let them click through —
    // /mentor/office-hours renders the slot in their local zone.
    await notify({
      userId: slot.mentor_id,
      type: "office_hours_booked",
      title: `${who} booked office hours`,
      body: input.topic
        ? `Topic: "${input.topic.slice(0, 80)}"`
        : "Open office hours to see the time.",
      link: "/mentor/office-hours",
    });
  } catch {}

  revalidatePath("/mentor/office-hours");
  revalidatePath("/dashboard/office-hours");
}

/**
 * Mentor posts (or updates) a recap after an office-hours session.
 * Only the slot's owning mentor can do this — the action verifies
 * ownership before touching the row. Empty body clears the recap so
 * the mentor can retract a draft.
 */
export async function saveBookingRecap(input: {
  bookingId: string;
  body: string;
}) {
  const { userId } = await assertStaff();
  const admin = createAdminClient();

  const { data: booking } = await admin
    .from("mentor_bookings")
    .select("id, student_id, slot:mentor_slots(mentor_id, starts_at)")
    .eq("id", input.bookingId)
    .maybeSingle();
  if (!booking) throw new Error("Booking not found.");
  const slot = Array.isArray((booking as any).slot)
    ? (booking as any).slot[0]
    : (booking as any).slot;
  if (slot.mentor_id !== userId) throw new Error("Forbidden");
  // Posting a recap before the session has even started is almost
  // always a confused click — guard so the mentor doesn't accidentally
  // overwrite next session's empty placeholder while preparing for it.
  if (new Date(slot.starts_at).getTime() > Date.now()) {
    throw new Error("Wait until the session is done before posting a recap.");
  }

  const trimmed = (input.body ?? "").trim().slice(0, 4000);
  const isClear = trimmed.length === 0;

  const { error } = await admin
    .from("mentor_bookings")
    .update({
      recap_notes: isClear ? null : trimmed,
      recap_posted_at: isClear ? null : new Date().toISOString(),
      // First recap = also flip status to "completed" so we don't
      // have to introduce a separate "mark complete" affordance.
      status: isClear ? undefined : "completed",
    })
    .eq("id", input.bookingId);
  if (error) throw new Error(error.message);

  // Best-effort notify so the student sees the recap landed.
  if (!isClear) {
    try {
      await notify({
        userId: booking.student_id,
        type: "office_hours_recap",
        title: "Recap posted from your office hours session",
        body: trimmed.slice(0, 140),
        link: "/dashboard/office-hours",
      });
    } catch {}
  }

  revalidatePath("/mentor/office-hours");
  revalidatePath("/dashboard/office-hours");
}

export async function cancelBooking(input: { bookingId: string }) {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { data: booking } = await admin
    .from("mentor_bookings")
    .select("id, student_id, slot:mentor_slots(mentor_id, starts_at)")
    .eq("id", input.bookingId)
    .maybeSingle();
  if (!booking) throw new Error("Not found");
  const slot = Array.isArray((booking as any).slot)
    ? (booking as any).slot[0]
    : (booking as any).slot;
  if (booking.student_id !== userId && slot.mentor_id !== userId) {
    throw new Error("Forbidden");
  }
  const { error } = await admin
    .from("mentor_bookings")
    .update({ status: "cancelled" })
    .eq("id", input.bookingId);
  if (error) throw new Error(error.message);
  revalidatePath("/mentor/office-hours");
  revalidatePath("/dashboard/office-hours");
}
