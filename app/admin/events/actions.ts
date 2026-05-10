"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertStaff } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { notifyMany } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { postChannelMessage, eventEmbed, getDiscordSettings } from "@/lib/discord";

export type EventInput = {
  id?: string;
  cohort_id: string | null;
  type: "demo_day" | "office_hours" | "workshop" | "other";
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  zoom_url: string | null;
  recording_url: string | null;
  visibility: "enrolled" | "staff" | "public";
};

export async function saveEvent(input: EventInput, notify: boolean) {
  await assertStaff();
  const admin = createAdminClient();
  const payload = {
    cohort_id: input.cohort_id || null,
    type: input.type,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    starts_at: input.starts_at,
    ends_at: input.ends_at || null,
    location: input.location?.trim() || null,
    zoom_url: input.zoom_url?.trim() || null,
    recording_url: input.recording_url?.trim() || null,
    visibility: input.visibility,
  };
  let id = input.id;
  if (id) {
    const { error } = await admin.from("events").update(payload).eq("id", id);
    if (error) throw new Error(error.message);
  } else {
    const { data: created, error } = await admin
      .from("events")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    id = created!.id;
  }

  await logAudit({
    action: input.id ? "event.updated" : "event.created",
    targetType: "event",
    targetId: id ?? null,
    payload: { title: input.title, type: input.type },
  });

  // Optionally fan out a notification + email to enrolled students.
  if (notify && input.cohort_id) {
    try {
      const { data: enrollments } = await admin
        .from("enrollments")
        .select("user_id, profile:profiles(email, full_name)")
        .eq("cohort_id", input.cohort_id);
      const recipients = (enrollments ?? []) as any[];
      await notifyMany(
        recipients.map((e) => ({
          userId: e.user_id,
          type: "event_posted",
          title: input.title,
          body: `Starts ${new Date(input.starts_at).toLocaleString()}`,
          link: "/dashboard/events",
        })),
      );
      const t = Templates.eventReminder({
        title: input.title,
        startsAt: input.starts_at,
        zoomUrl: input.zoom_url,
      });
      const emails = recipients
        .map((e) =>
          Array.isArray(e.profile) ? e.profile[0]?.email : e.profile?.email,
        )
        .filter(Boolean) as string[];
      for (const to of emails) {
        await sendEmail({ to, subject: t.subject, html: t.html });
      }
    } catch (err) {
      console.error("[events] notify failed", err);
    }
  }

  // Cross-post to Discord's events channel for every save (works for
  // both new and updated events). Best-effort.
  if (notify) {
    try {
      const settings = await getDiscordSettings();
      if (settings.eventsChannelId) {
        let cohortName: string | null = null;
        if (input.cohort_id) {
          const { data: c } = await admin
            .from("cohorts")
            .select("name")
            .eq("id", input.cohort_id)
            .maybeSingle();
          cohortName = c?.name ?? null;
        }
        await postChannelMessage(settings.eventsChannelId, {
          embeds: [
            eventEmbed({
              title: payload.title,
              description: payload.description,
              startsAt: payload.starts_at,
              endsAt: payload.ends_at,
              location: payload.location,
              zoomUrl: payload.zoom_url,
              type: payload.type,
              cohortName,
            }),
          ],
        });
      }
    } catch (err) {
      console.error("[events] discord post failed", err);
    }
  }

  revalidatePath("/admin/events");
  revalidatePath("/dashboard/events");
}

export async function deleteEvent(id: string) {
  await assertStaff();
  const admin = createAdminClient();
  const { error } = await admin.from("events").delete().eq("id", id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "event.deleted",
    targetType: "event",
    targetId: id,
  });
  revalidatePath("/admin/events");
  revalidatePath("/dashboard/events");
}
