import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, getProfile } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { SlotsList } from "./slots-list";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";
import { CheckCircle2, MessageSquare } from "lucide-react";

export const metadata = { title: "Office hours · SparkLine Youth" };

export default async function StudentOfficeHoursPage() {
  const user = await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");
  if (!access.enrolled) {
    return (
      <LockedFeature
        title="Office hours"
        applicationStatus={access.applicationStatus}
      />
    );
  }
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

  // Past sessions the student has booked, ordered most-recent first.
  // We need the recap copy + the mentor's name, so we join through the
  // slot. Limit to 10 — past that, the noise dwarfs the signal.
  const { data: pastBookings } = await admin
    .from("mentor_bookings")
    .select(
      "id, topic, recap_notes, recap_posted_at, status, slot:mentor_slots(starts_at, mentor:profiles(full_name, email))",
    )
    .eq("student_id", user.id)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(10);
  const pastRows = (pastBookings ?? [])
    .map((b: any) => {
      const slot = Array.isArray(b.slot) ? b.slot[0] : b.slot;
      const mentor = slot
        ? Array.isArray(slot.mentor)
          ? slot.mentor[0]
          : slot.mentor
        : null;
      return { ...b, slot, mentor };
    })
    .filter(
      (b: any) => b.slot && new Date(b.slot.starts_at).getTime() < Date.now(),
    );

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

      {pastRows.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
            Past sessions
          </h2>
          <ul className="mt-3 space-y-3">
            {pastRows.map((b: any) => (
              <li
                key={b.id}
                className="rounded-lg border border-white/10 bg-white/[0.02] p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm font-medium text-white">
                    {b.mentor?.full_name ?? b.mentor?.email ?? "Mentor"}
                  </div>
                  <span className="text-xs text-white/45">
                    <LocalTime value={b.slot.starts_at} />
                  </span>
                </div>
                {b.topic && (
                  <p className="mt-1 text-xs text-white/55">
                    Topic: {b.topic}
                  </p>
                )}
                {b.recap_notes ? (
                  <div className="mt-3 rounded border border-emerald-400/20 bg-emerald-400/[0.04] px-3 py-2">
                    <div className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" />
                      Recap
                      {b.recap_posted_at && (
                        <span className="ml-1 normal-case tracking-normal text-emerald-200/60">
                          ·{" "}
                          <LocalTime
                            value={b.recap_posted_at}
                            mode="datetime-short"
                          />
                        </span>
                      )}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm text-white/85">
                      {b.recap_notes}
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-white/35">
                    <MessageSquare className="h-3 w-3" />
                    No recap yet
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
