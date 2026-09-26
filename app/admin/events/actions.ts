"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { notifyMany } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import {
  postChannelMessage,
  eventEmbed,
  getDiscordSettings,
  buttonRow,
} from "@/lib/discord";
import {
  createRoom,
  deleteRoom,
  updateRoomExpiry,
  dailyConfigured,
} from "@/lib/daily";
import {
  DEFAULT_EVENT_MINUTES,
  normalizeDisplayViewers,
  roomWindow,
  type LiveMode,
} from "@/lib/live";
import {
  isHostedOnBatch0,
  normalizeAudienceMode,
  type AudienceMode,
} from "@/lib/webinars";
import { env } from "@/lib/env";

/**
 * Where "join" should point for this event, in email and on Discord.
 *
 * Both batch0-hosted modes (hosted and premiere) link to batch0.org, never to
 * a room URL directly. The room is private, so a raw link is useless without
 * credentials — and the page that mints them is the same page that checks
 * whether the viewer is allowed in at all. This used to test `=== "hosted"`,
 * so every premiere announcement went out with no link.
 */
function joinUrl(
  mode: LiveMode,
  eventId: string,
  externalUrl: string | null,
): string | null {
  return isHostedOnBatch0(mode)
    ? `${env.siteUrl}/dashboard/events/${eventId}/live`
    : externalUrl;
}

/**
 * When a hosted room should stop existing.
 *
 * Daily deletes the room at `exp`, so this is also the cleanup policy. The
 * two-hour tail past the end is deliberate: rooms that evict people mid-
 * sentence because the admin guessed the end time badly are worse than rooms
 * that linger, and lingering costs nothing (billing is per participant-minute,
 * and an empty room has none).
 */
function roomExpiry(startsAt: string, endsAt: string | null): Date {
  const end = endsAt
    ? new Date(endsAt)
    : new Date(new Date(startsAt).getTime() + DEFAULT_EVENT_MINUTES * 60_000);
  return new Date(end.getTime() + 2 * 60 * 60 * 1000);
}

export type EventInput = {
  id?: string;
  cohort_id: string | null;
  type: "demo_day" | "office_hours" | "workshop" | "webinar" | "other";
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  zoom_url: string | null;
  recording_url: string | null;
  visibility: "enrolled" | "staff" | "public";
  live_mode: LiveMode;
  /**
   * Announced attendance shown in the live room in place of the hidden roster
   * ("43 watching"). Null / omitted = the private default. Display only — see
   * lib/live.ts. Sanitized on save regardless of what the form sends.
   */
  display_viewer_count?: number | null;
  daily_room_name?: string | null;
  daily_room_url?: string | null;

  // ---- Webinar settings (migration 0084) ---------------------------------
  //
  // All optional, and every one of them defaults to the behaviour the event
  // had before 0084. An admin surface that does not know about webinars — or a
  // caller written before this block existed — saves an event unchanged rather
  // than silently switching its audience on or starting to record it.
  /** May the audience see itself? See lib/webinars.ts. Omitted = 'private'. */
  audience_mode?: AudienceMode;
  /** Start recording when the host starts broadcasting. Omitted = off. */
  auto_record?: boolean;
  /** Email the deck and recording out afterwards. Omitted = off. */
  auto_share?: boolean;
  /** Premiere only: when the genuinely-live Q&A opens. */
  qa_opens_at?: string | null;
};

/**
 * Returns the event's id — including for an insert, where the caller could not
 * have known it. That is what lets the admin form attach guest speakers to an
 * event it is creating for the first time, in the same click, instead of making
 * the admin save once and come back.
 */
export async function saveEvent(
  input: EventInput,
  notify: boolean,
): Promise<string> {
  await assertPermission("events.manage");
  const admin = createAdminClient();

  // ---- Hosted room lifecycle ---------------------------------------------
  //
  // Switching an event to "hosted" creates the room; switching it back (or
  // deleting the event) tears it down. Done here rather than lazily at join
  // time so the failure — a bad key, a Daily outage — surfaces to the admin
  // who is looking at the form, not to twenty students at 7pm.
  //
  // ALL OF THIS IS A NO-OP ON batch0 Live, which is the default. The built-in
  // provider has no provider-side room: the event id is the room, credentials
  // are minted per join, and there is nothing to create, re-stamp, or reap.
  // That deletes the entire class of bug this block exists to manage — 0069
  // moved every webinar to a Sunday and left 17 of 18 pointing at a room that
  // expired before the webinar started, because the schedule moved and the
  // room did not.
  // Daily never hosted a premiere — that mode arrived with batch0 Live — so a
  // premiere must not take this path even on an environment still pinned to
  // Daily. It would create a room nobody joins and stamp the row with it.
  const usesProviderRooms =
    env.liveProvider === "daily" && input.live_mode !== "premiere";
  let roomName = input.daily_room_name ?? null;
  let roomUrl = input.daily_room_url ?? null;

  // A hosted event that already has a room is being re-saved — most likely
  // with a new time. The room was stamped with the OLD end time as its `exp`,
  // and Daily deletes it then, so the room must follow the schedule or the
  // webinar opens on the new date to a room that no longer exists. If Daily
  // has already reaped it, drop the name and fall through to create a fresh
  // one below. Anything else Daily says here is not worth failing the save
  // over: the join page also re-checks the room and heals a dead one.
  if (usesProviderRooms && input.live_mode === "hosted" && roomName) {
    try {
      const stillThere = await updateRoomExpiry(
        roomName,
        roomExpiry(input.starts_at, input.ends_at),
      );
      if (!stillThere) {
        roomName = null;
        roomUrl = null;
      }
    } catch (err) {
      console.error("[events] could not move room expiry", err);
    }
  }

  if (usesProviderRooms && input.live_mode === "hosted" && !roomName) {
    if (!dailyConfigured()) {
      throw new Error(
        "Live video isn't configured — set DAILY_API_KEY and NEXT_PUBLIC_DAILY_DOMAIN, or use a Zoom link instead.",
      );
    }
    const room = await createRoom({
      namePrefix: input.title || "event",
      mode: "webinar",
      // Daily deletes the room at `exp`, so this doubles as cleanup. Generous
      // padding: an event that overruns should not evict everyone.
      expiresAt: roomExpiry(input.starts_at, input.ends_at),
      enableRecording: true,
    });
    roomName = room.name;
    roomUrl = room.url;
  }

  if (input.live_mode === "external" && roomName) {
    // Best-effort: an event that can't drop its room should still save as
    // external. The room expires on its own regardless. Still attempted when
    // the built-in provider is active, because the name may be a leftover
    // Daily room from before the switch and reaping it costs nothing.
    if (dailyConfigured()) {
      try {
        await deleteRoom(roomName);
      } catch (err) {
        console.error("[events] could not delete room", err);
      }
    }
    roomName = null;
    roomUrl = null;
  }

  // ---- Live state on a rescheduled event ---------------------------------
  //
  // `live_started_at`, `live_ended_at` and `assets_shared_at` describe ONE
  // run of an event. The recommended staff-only rehearsal on the same row, or
  // simply moving an event to next week, used to carry the old run's stamps
  // into the new one: the real webinar opened already "Ended" (and, since End
  // is now enforced, refused everyone), a premiere read the old
  // live_started_at as "a host went live" and never played, and the follow-up
  // email never went out because the rehearsal had already claimed it.
  //
  // So a stamp that predates the new schedule's host window (start - 60m) is
  // from a previous run and is cleared; a stamp inside the window is this
  // run's and is kept (an admin fixing a typo in the title mid-webinar must
  // not reopen it). The follow-up claim is cleared whenever the new end is
  // still ahead — nothing can have been shared about a webinar that has not
  // happened yet.
  const liveReset: {
    live_started_at?: null;
    live_ended_at?: null;
    assets_shared_at?: null;
  } = {};
  if (input.id) {
    const { data: prior } = await admin
      .from("events")
      .select("live_started_at, live_ended_at, assets_shared_at")
      .eq("id", input.id)
      .maybeSingle();
    const p = prior as any;
    if (p) {
      const w = roomWindow(input.starts_at, input.ends_at || null);
      const stale = (at: string | null) =>
        !!at && new Date(at).getTime() < w.hostOpensAt;
      if (stale(p.live_started_at)) liveReset.live_started_at = null;
      if (stale(p.live_ended_at)) liveReset.live_ended_at = null;
      if (p.assets_shared_at && w.end > Date.now()) {
        liveReset.assets_shared_at = null;
      }
    }
  }

  // A staff-only event is a rehearsal or an internal session. Emailing its
  // recording to a cohort is never what anyone meant, so auto-share is forced
  // off for it here as well as in the form (and the follow-up cron skips staff
  // events too).
  const autoShare = input.visibility === "staff" ? false : !!input.auto_share;

  const payload = {
    cohort_id: input.cohort_id || null,
    type: input.type,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    starts_at: input.starts_at,
    ends_at: input.ends_at || null,
    location: input.location?.trim() || null,
    // An external link only means something for an external event. A leftover
    // Zoom URL on a hosted webinar is a second, wrong "join" in the admin list
    // and a stale link in anything that reads the column.
    zoom_url:
      input.live_mode === "external" ? input.zoom_url?.trim() || null : null,
    recording_url: input.recording_url?.trim() || null,
    visibility: input.visibility,
    live_mode: input.live_mode,
    // Re-sanitized here, not trusted from the form: the room reads this back to
    // decide what number the whole audience sees.
    display_viewer_count: normalizeDisplayViewers(input.display_viewer_count),
    daily_room_name: roomName,
    daily_room_url: roomUrl,

    // Re-sanitized on the way in, exactly like display_viewer_count and for a
    // sharper reason: this value decides whether one student's words are shown
    // to another. `normalizeAudienceMode` fails closed, so a form that sends
    // nothing, or a value this build does not recognise, stores 'private'.
    audience_mode: normalizeAudienceMode(input.audience_mode),
    auto_record: !!input.auto_record,
    auto_share: autoShare,
    // Only meaningful for a premiere. Cleared otherwise, so switching an event
    // away from premiere cannot leave a handover time behind that a later
    // switch back would silently resurrect.
    qa_opens_at:
      input.live_mode === "premiere" ? input.qa_opens_at || null : null,
    ...liveReset,
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
          // Notification body is a fixed string baked at creation
          // time, and we don't know the recipient's timezone. Keep the
          // copy generic and let them click through to /dashboard/events,
          // where times render in the viewer's local zone.
          body: "New event posted. Open events to see when it starts.",
          link: "/dashboard/events",
        })),
      );
      const t = Templates.eventReminder({
        title: input.title,
        startsAt: input.starts_at,
        // A hosted event's join link is on batch0.org, not the provider's
        // domain. Sending the raw room URL would work but bypasses the token
        // mint — anyone forwarded the email would hit a private room they
        // have no ticket for, which reads as "the link is broken".
        zoomUrl: joinUrl(payload.live_mode, id!, payload.zoom_url),
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
        // RSVP buttons — clicks fire `rsvp:<status>:<eventId>` into
        // /api/discord/interactions, which writes the row + marks the
        // user's onboarding step 3 done.
        const rsvpButtons = id
          ? [
              buttonRow([
                {
                  customId: `rsvp:going:${id}`,
                  label: "I'm in",
                  style: 3,
                  emoji: "✅",
                },
                {
                  customId: `rsvp:maybe:${id}`,
                  label: "Maybe",
                  style: 2,
                  emoji: "🤔",
                },
                {
                  customId: `rsvp:declined:${id}`,
                  label: "Can't make it",
                  style: 2,
                  emoji: "❌",
                },
              ]),
            ]
          : undefined;
        await postChannelMessage(settings.eventsChannelId, {
          embeds: [
            eventEmbed({
              title: payload.title,
              description: payload.description,
              startsAt: payload.starts_at,
              endsAt: payload.ends_at,
              location: payload.location,
              zoomUrl: joinUrl(payload.live_mode, id!, payload.zoom_url),
              type: payload.type,
              cohortName,
            }),
          ],
          components: rsvpButtons,
        });
      }
    } catch (err) {
      console.error("[events] discord post failed", err);
    }
  }

  revalidatePath("/admin/events");
  revalidatePath("/dashboard/events");
  return id!;
}

export async function deleteEvent(id: string) {
  await assertPermission("events.manage");
  const admin = createAdminClient();

  // Drop the room before the row, since the row is the only record of the
  // room's name. Best-effort — a room we fail to delete expires on its own,
  // whereas an event that refuses to delete is a stuck admin.
  const { data: existing } = await admin
    .from("events")
    .select("daily_room_name")
    .eq("id", id)
    .maybeSingle();
  const roomName = (existing as any)?.daily_room_name as string | null;
  if (roomName) {
    try {
      await deleteRoom(roomName);
    } catch (err) {
      console.error("[events] could not delete room on event delete", err);
    }
  }

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
