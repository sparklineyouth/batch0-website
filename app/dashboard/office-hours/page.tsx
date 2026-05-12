import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { SlotsList } from "./slots-list";

export const metadata = { title: "Office hours · SparkLine" };

export default async function StudentOfficeHoursPage() {
  const user = await requireUser();
  const admin = createAdminClient();

  // Slots in the next 14 days, with their booking (if any), and the mentor's
  // name. Show open slots prominently; show the student's own bookings too.
  const horizon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: slots } = await admin
    .from("mentor_slots")
    .select(
      "id, starts_at, ends_at, zoom_url, notes, mentor:profiles(id, full_name, email)",
    )
    .gte("starts_at", new Date().toISOString())
    .lte("starts_at", horizon)
    .order("starts_at", { ascending: true });

  const slotIds = (slots ?? []).map((s: any) => s.id);
  const { data: bookings } = slotIds.length
    ? await admin
        .from("mentor_bookings")
        .select("id, slot_id, student_id, status, topic")
        .in("slot_id", slotIds)
    : { data: [] as any[] };

  const bookingBySlot = new Map<string, any>();
  for (const b of (bookings ?? []) as any[]) {
    if (b.status !== "cancelled") bookingBySlot.set(b.slot_id, b);
  }

  const rows = (slots ?? []).map((s: any) => {
    const b = bookingBySlot.get(s.id);
    const taken = !!b;
    const mine = b?.student_id === user.id;
    return {
      ...s,
      booking_id: b?.id ?? null,
      taken,
      mine,
    };
  });

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Office hours</h1>
      <p className="mt-1 text-sm text-white/55">
        Pick a slot with a mentor. They'll see your topic so they can show up
        prepared.
      </p>

      {rows.length === 0 ? (
        <Card className="mt-8 text-center">
          <p className="text-sm text-white/50">
            No mentor slots published in the next two weeks. Check back later.
          </p>
        </Card>
      ) : (
        <div className="mt-6">
          <SlotsList slots={rows} />
        </div>
      )}
    </div>
  );
}
