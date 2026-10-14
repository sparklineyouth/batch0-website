import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyMany } from "@/lib/notifications";
import { sendEmailBatch } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { isHostedOnBatch0 } from "@/lib/webinars";

type Admin = ReturnType<typeof createAdminClient>;

export type NotifyEvent = {
  id: string;
  title: string;
  startsAt: string;
  visibility: string;
  cohortId: string | null;
  liveMode: string;
  externalUrl: string | null;
};

type Recipient = { userId: string; email: string | null };

/**
 * Who hears about an event: the students of its cohort, or — for an
 * "everyone signed in" event with no cohort — the students of every cohort
 * that hasn't finished. Staff-only events reach nobody (the action refuses
 * before getting here; this is the backstop).
 */
async function recipientsFor(admin: Admin, ev: NotifyEvent): Promise<Recipient[]> {
  if (ev.visibility === "staff") return [];
  let cohortIds: string[];
  if (ev.cohortId) {
    cohortIds = [ev.cohortId];
  } else if (ev.visibility === "public") {
    const { data } = await admin
      .from("cohorts")
      .select("id")
      .in("status", ["upcoming", "active"]);
    cohortIds = (data ?? []).map((c: any) => c.id as string);
  } else {
    return [];
  }
  if (cohortIds.length === 0) return [];
  const { data, error } = await admin
    .from("enrollments")
    .select("user_id, profile:profiles(email)")
    .in("cohort_id", cohortIds);
  if (error) throw new Error(error.message);
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const row of (data ?? []) as any[]) {
    if (seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    const p = Array.isArray(row.profile) ? row.profile[0] : row.profile;
    out.push({ userId: row.user_id, email: p?.email ?? null });
  }
  return out;
}

function roomUrl(eventId: string): string {
  return `${env.siteUrl}/dashboard/events/${eventId}/live`;
}

/** "New event" / "Updated": a bell plus one batched email per recipient. */
export async function announceEvent(ev: NotifyEvent, isNew: boolean): Promise<void> {
  try {
    const admin = createAdminClient();
    const people = await recipientsFor(admin, ev);
    if (people.length === 0) return;
    await notifyMany(
      people.map((p) => ({
        userId: p.userId,
        type: "event_posted",
        title: ev.title,
        body: isNew ? "New event. Open Events for the time." : "Event updated. Open Events for the time.",
        link: "/dashboard/events",
      })),
    );
    const t = Templates.eventReminder({
      title: ev.title,
      startsAt: ev.startsAt,
      // Hosted events link to batch0, which checks who may join; never a raw room.
      zoomUrl: isHostedOnBatch0(ev.liveMode) ? roomUrl(ev.id) : ev.externalUrl,
    });
    await sendEmailBatch(
      people
        .filter((p) => p.email)
        .map((p) => ({
          to: p.email!,
          subject: t.subject,
          html: t.html,
          templateKey: "event.reminder",
        })),
    );
  } catch (err) {
    console.error("[events] notify failed", err);
  }
}

/** "<host> is live now": a bell plus one batched email per recipient. */
export async function announceLive(ev: NotifyEvent, hostName: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const people = await recipientsFor(admin, ev);
    if (people.length === 0) return;
    const link = `/dashboard/events/${ev.id}/live`;
    await notifyMany(
      people.map((p) => ({
        userId: p.userId,
        type: "event_live",
        title: `${hostName} is live now`,
        body: ev.title,
        link,
        dedupeKey: `event-live:${ev.id}`,
      })),
    );
    const t = Templates.eventLive({ title: ev.title, hostName, joinUrl: roomUrl(ev.id) });
    await sendEmailBatch(
      people
        .filter((p) => p.email)
        .map((p) => ({
          to: p.email!,
          subject: t.subject,
          html: t.html,
          templateKey: "event.live",
        })),
    );
  } catch (err) {
    console.error("[events] live notify failed", err);
  }
}
