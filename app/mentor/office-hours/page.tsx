import { createAdminClient } from "@/lib/supabase/admin";
import { requireMentor } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { SlotsManager } from "./slots-manager";

export const metadata = { title: "Office hours · Mentor" };

export default async function MentorOfficeHoursPage() {
  const profile = await requireMentor();
  const admin = createAdminClient();

  const { data: slots } = await admin
    .from("mentor_slots")
    .select("*")
    .eq("mentor_id", profile.id)
    .order("starts_at", { ascending: true });

  const slotIds = (slots ?? []).map((s: any) => s.id);
  const { data: bookings } = slotIds.length
    ? await admin
        .from("mentor_bookings")
        .select(
          "id, slot_id, status, topic, student_id, recap_notes, recap_posted_at, student:profiles(full_name, email)",
        )
        .in("slot_id", slotIds)
    : { data: [] as any[] };

  const bookingBySlot = new Map<string, any>();
  for (const b of (bookings ?? []) as any[]) {
    if (b.status !== "cancelled") bookingBySlot.set(b.slot_id, b);
  }

  const enriched = (slots ?? []).map((s: any) => ({
    ...s,
    booking: bookingBySlot.get(s.id) ?? null,
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Office hours</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Publish slots students can claim. Cancellations free the slot up
        instantly.
      </p>
      <div className="mt-6">
        <SlotsManager slots={enriched} />
      </div>
    </div>
  );
}
