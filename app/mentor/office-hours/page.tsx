import { createAdminClient } from "@/lib/supabase/admin";
import { requireMentor } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { SlotsManager } from "./slots-manager";

export const metadata = { title: "Office hours · Mentor" };

export default async function MentorOfficeHoursPage() {
  const profile = await requireMentor();
  const admin = createAdminClient();

  // Bookings ride along as an embed instead of a dependent second query.
  // slot_id is unique on mentor_bookings, so PostgREST resolves this as
  // to-one and hands back an object (or null) per slot.
  const { data: slots } = await admin
    .from("mentor_slots")
    .select(
      "*, mentor_bookings(id, slot_id, status, topic, student_id, recap_notes, recap_posted_at, student:profiles(full_name, email))",
    )
    .eq("mentor_id", profile.id)
    .order("starts_at", { ascending: true });

  // SlotsManager wants a `booking` field holding the live (non-cancelled)
  // booking or null; normalize the embed shape defensively in case the
  // schema cache serves it as an array.
  const enriched = (slots ?? []).map((s: any) => {
    const { mentor_bookings: raw, ...slot } = s;
    const bookings = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const booking = bookings.find((b: any) => b.status !== "cancelled") ?? null;
    return { ...slot, booking };
  });

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
