import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyMany } from "@/lib/notifications";
import { sendEmailBatch } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { isHostedOnBatch0 } from "@/lib/webinars";
import { computePreCohort, type PreCohortCohort } from "@/lib/pre-cohort";
import { eventNoticeLink } from "@/lib/event-form";

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

type Recipient = { userId: string; email: string | null; preCohort: boolean };

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function cohortOf(row: any): PreCohortCohort | null {
  const c = one<any>(row.cohort);
  return c ? { starts_on: c.starts_on ?? null, status: c.status ?? null } : null;
}

/**
 * Who hears about an event: the students of its cohort, or — for an
 * "everyone signed in" event with no cohort — the students of every cohort
 * that hasn't finished. Staff-only events reach nobody (the action refuses
 * before getting here; this is the backstop).
 *
 * `preCohort` marks a student none of whose cohorts has started: the
 * middleware keeps them out of /dashboard/events (lib/pre-cohort.ts), so
 * eventNoticeLink sends them to the room or leaves them out.
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
    .select("user_id, profile:profiles(email), cohort:cohorts(starts_on, status)")
    .in("cohort_id", cohortIds);
  if (error) throw new Error(error.message);

  type Person = { email: string | null; cohorts: PreCohortCohort[] };
  const people = new Map<string, Person>();
  for (const row of (data ?? []) as any[]) {
    const p: Person = people.get(row.user_id) ?? {
      email: one<any>(row.profile)?.email ?? null,
      cohorts: [],
    };
    const c = cohortOf(row);
    if (c) p.cohorts.push(c);
    people.set(row.user_id, p);
  }

  // Lockdown looks at ALL of a student's cohorts: someone in a running cohort
  // who is also enrolled in the next one is not locked out. Only those whose
  // targeted cohort hasn't started need the wider look.
  const unsure = [...people]
    .filter(([, p]) => computePreCohort(true, p.cohorts))
    .map(([id]) => id);
  for (let i = 0; i < unsure.length; i += 200) {
    const { data: more, error: moreError } = await admin
      .from("enrollments")
      .select("user_id, cohort:cohorts(starts_on, status)")
      .in("user_id", unsure.slice(i, i + 200));
    if (moreError) throw new Error(moreError.message);
    for (const row of (more ?? []) as any[]) {
      const c = cohortOf(row);
      if (c) people.get(row.user_id)?.cohorts.push(c);
    }
  }

  return [...people].map(([userId, p]) => ({
    userId,
    email: p.email,
    preCohort: computePreCohort(true, p.cohorts),
  }));
}

/** Each recipient with the link their notice carries; the unreachable are dropped. */
function withLinks(people: Recipient[], ev: NotifyEvent, kind: "posted" | "live") {
  const hosted = isHostedOnBatch0(ev.liveMode);
  return people.flatMap((p) => {
    const link = eventNoticeLink({ id: ev.id, hosted }, kind, p.preCohort);
    return link ? [{ ...p, link }] : [];
  });
}

/** One rendered email per distinct link, shared by everyone it goes to. */
function emailsByLink<T extends { subject: string; html: string }>(
  people: { email: string | null; link: string }[],
  render: (link: string) => T,
  templateKey: string,
) {
  const rendered = new Map<string, T>();
  return people
    .filter((p) => p.email)
    .map((p) => {
      let t = rendered.get(p.link);
      if (!t) {
        t = render(p.link);
        rendered.set(p.link, t);
      }
      return { to: p.email!, subject: t.subject, html: t.html, templateKey };
    });
}

/** "New event" / "Updated": a bell plus one batched email per recipient. */
export async function announceEvent(ev: NotifyEvent, isNew: boolean): Promise<void> {
  try {
    const admin = createAdminClient();
    const people = withLinks(await recipientsFor(admin, ev), ev, "posted");
    if (people.length === 0) return;
    await notifyMany(
      people.map((p) => ({
        userId: p.userId,
        type: "event_posted",
        title: ev.title,
        body: isNew ? "New event. Open it for the time." : "Event updated. Open it for the time.",
        link: p.link,
      })),
    );
    // Hosted events link to batch0, which checks who may join; never a raw room.
    const joinUrl = isHostedOnBatch0(ev.liveMode)
      ? `${env.siteUrl}/dashboard/events/${ev.id}/live`
      : ev.externalUrl;
    await sendEmailBatch(
      emailsByLink(
        people,
        (link) =>
          Templates.eventReminder({
            title: ev.title,
            startsAt: ev.startsAt,
            zoomUrl: joinUrl,
            cta:
              link === "/dashboard/events"
                ? undefined
                : { url: `${env.siteUrl}${link}`, label: "Open the event" },
          }),
        "event.reminder",
      ),
    );
  } catch (err) {
    console.error("[events] notify failed", err);
  }
}

/** "<host> is live now": a bell plus one batched email per recipient. */
export async function announceLive(ev: NotifyEvent, hostName: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const people = withLinks(await recipientsFor(admin, ev), ev, "live");
    if (people.length === 0) return;
    await notifyMany(
      people.map((p) => ({
        userId: p.userId,
        type: "event_live",
        title: `${hostName} is live now`,
        body: ev.title,
        link: p.link,
        dedupeKey: `event-live:${ev.id}`,
      })),
    );
    await sendEmailBatch(
      emailsByLink(
        people,
        (link) =>
          Templates.eventLive({ title: ev.title, hostName, joinUrl: `${env.siteUrl}${link}` }),
        "event.live",
      ),
    );
  } catch (err) {
    console.error("[events] live notify failed", err);
  }
}
