"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";
import { notify } from "@/lib/notifications";

async function assertMentorOrAdmin(userId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (!data || (data.role !== "mentor" && data.role !== "admin")) {
    throw new Error("Forbidden");
  }
  return data.role as string;
}

export async function createSlot(input: {
  startsAt: string;
  endsAt: string;
  zoomUrl?: string;
  notes?: string;
}) {
  const { userId } = await assertSelf();
  await assertMentorOrAdmin(userId);

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
  const { userId } = await assertSelf();
  await assertMentorOrAdmin(userId);
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
