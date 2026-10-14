"use server";
import { after } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";
import { GLOBAL_CONTENT_TAG } from "@/lib/app-cache";
import {
  DEFAULT_AUDIENCE_MODE,
  normalizeAudienceMode,
  type AudienceMode,
} from "@/lib/webinars";
import {
  audienceFor,
  DEFAULT_DURATION_MINUTES,
  DEFAULT_LIVE_TITLE,
  durationOf,
  endsAtFor,
  floorToMinute,
  isEventType,
  isUuid,
  liveForAudience,
  MAX_TITLE_LENGTH,
  parseHttpUrl,
  parseWho,
  pickDefaultCohort,
  staleRunStamps,
  validateEventFields,
  type EventType,
  type Who,
} from "@/lib/event-form";
import { announceEvent, announceLive, type NotifyEvent } from "./notify";
import { deleteRoomRecordings } from "@/lib/recording-sessions";
import {
  attachDeck,
  removeObjects,
  verifyStagedDeck,
  type StagedDeck,
} from "./deck";

type Admin = ReturnType<typeof createAdminClient>;

export type EventFormInput = {
  /** The event being edited, or null for a new one. */
  id: string | null;
  /** A new event's id, minted when slides were uploaded before the first save. */
  draftId: string | null;
  title: string;
  /** ISO. */
  startsAt: string;
  durationMinutes: number;
  liveMode: "hosted" | "external";
  externalUrl: string;
  /** "cohort:<id>" | "public" | "staff" — see lib/event-form.ts. */
  who: string;
  notify: boolean;
  description: string;
  type: EventType;
  location: string;
  audienceMode: AudienceMode;
  autoRecord: boolean;
  autoShare: boolean;
  recordingUrl: string;
  deck: StagedDeck | null;
};

/** Every surface that lists events. */
function revalidateEventViews() {
  revalidatePath("/admin/events");
  revalidatePath("/dashboard/events");
  // /program and /parents read a cached timetable; the app caches events.
  revalidateTag("public-cohort-timetable");
  revalidateTag(GLOBAL_CONTENT_TAG);
}

async function assertCohortExists(admin: Admin, who: Who) {
  if (who.kind !== "cohort") return;
  const { data } = await admin
    .from("cohorts")
    .select("id")
    .eq("id", who.cohortId)
    .maybeSingle();
  if (!data) throw new Error("That cohort no longer exists.");
}

/** A validated link, or null. Callers have already run validateEventFields. */
function linkOrNull(input: string): string | null {
  const parsed = parseHttpUrl(input);
  return parsed.ok ? parsed.url : null;
}

/**
 * Create or edit an event. Returns its id, plus a warning when the event saved
 * but its slides did not attach.
 */
export async function saveEvent(
  input: EventFormInput,
): Promise<ActionResult<{ id: string; warning?: string }>> {
  return runAction({ name: "saveEvent" }, async () => {
    const actor = await assertPermission("events.manage");
    const admin = createAdminClient();

    if (input.id && !isUuid(input.id)) throw new Error("That event no longer exists.");
    if (!input.id && input.draftId && !isUuid(input.draftId)) {
      throw new Error("Open the form again.");
    }

    let prior: Record<string, string | null> | null = null;
    if (input.id) {
      const { data, error } = await admin
        .from("events")
        .select("id, cohort_id, starts_at, ends_at, live_started_at, live_ended_at, assets_shared_at")
        .eq("id", input.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("That event no longer exists.");
      prior = data as Record<string, string | null>;
    }

    const firstError = Object.values(
      validateEventFields({
        title: input.title,
        startsAt: input.startsAt,
        durationMinutes: input.durationMinutes,
        liveMode: input.liveMode,
        externalUrl: input.externalUrl,
        recordingUrl: input.recordingUrl,
        who: input.who,
        savedDurationMinutes: prior ? durationOf(prior.starts_at!, prior.ends_at) : null,
      }),
    )[0];
    if (firstError) throw new Error(firstError);
    if (input.liveMode !== "hosted" && input.liveMode !== "external") {
      throw new Error("Pick where it happens.");
    }
    if (!isEventType(input.type)) throw new Error("Pick a type.");
    const who = parseWho(input.who)!;
    if (who.kind === "staff" && input.notify) {
      throw new Error("Staff-only events don't notify anyone.");
    }
    await assertCohortExists(admin, who);
    const targetId = input.id ?? input.draftId ?? null;
    if (input.deck) {
      if (!targetId) throw new Error("Pick the slides again.");
      await verifyStagedDeck(admin, targetId, input.deck);
    }

    const startsAt = new Date(input.startsAt).toISOString();
    const endsAt = endsAtFor(startsAt, input.durationMinutes);
    const hosted = input.liveMode === "hosted";
    const audience = audienceFor(who, prior?.cohort_id ?? null);

    // A reschedule must not leave the event "Ended" by an earlier run.
    const liveReset = prior ? staleRunStamps(prior, startsAt) : {};

    const payload = {
      cohort_id: audience.cohort_id,
      visibility: audience.visibility,
      type: input.type,
      title: input.title.trim().slice(0, MAX_TITLE_LENGTH),
      description: input.description?.trim() || null,
      starts_at: startsAt,
      ends_at: endsAt,
      location: input.location?.trim() || null,
      live_mode: input.liveMode,
      zoom_url: hosted ? null : linkOrNull(input.externalUrl),
      recording_url: linkOrNull(input.recordingUrl),
      audience_mode: normalizeAudienceMode(input.audienceMode),
      // The "shown attendees" headcount is gone; clear any left on old rows.
      display_viewer_count: null,
      auto_record: hosted && !!input.autoRecord,
      // A rehearsal never emails a cohort.
      auto_share: audience.visibility !== "staff" && !!input.autoShare,
      ...liveReset,
    };

    let id: string;
    if (input.id) {
      const { error } = await admin.from("events").update(payload).eq("id", input.id);
      if (error) throw new Error(error.message);
      id = input.id;
    } else {
      const row: Record<string, unknown> = input.draftId
        ? { ...payload, id: input.draftId }
        : payload;
      const { data, error } = await admin.from("events").insert(row).select("id").single();
      if (error) throw new Error(error.message);
      id = (data as { id: string }).id;
    }

    let warning: string | undefined;
    if (input.deck) {
      try {
        await attachDeck(admin, id, input.deck, actor.userId);
      } catch (err) {
        console.error("[events] deck attach failed", err);
        warning = "Saved, but the slides didn't attach. Pick the file again.";
      }
    }

    await logAudit({
      action: input.id ? "event.updated" : "event.created",
      targetType: "event",
      targetId: id,
      payload: {
        title: payload.title,
        type: payload.type,
        visibility: payload.visibility,
        notify: input.notify,
      },
    });
    revalidateEventViews();

    if (input.notify) {
      const ev: NotifyEvent = {
        id,
        title: payload.title,
        startsAt,
        visibility: audience.visibility,
        cohortId: audience.cohort_id,
        liveMode: payload.live_mode,
        externalUrl: payload.zoom_url,
      };
      after(() => announceEvent(ev, !input.id));
    }
    return warning ? { id, warning } : { id };
  });
}

/**
 * "Start a webinar now": a hosted webinar starting this minute for the running
 * (else next) cohort, already marked live, then straight into the room.
 *
 * While a webinar for the same people is already live (two admins pressing
 * it, or a stale page) it starts nothing and returns that one, so the dialog
 * can offer Join; `again` says the admin saw it and wants a second room.
 */
export async function startWebinarNow(input: {
  title?: string;
  who?: string;
  notify: boolean;
  again?: boolean;
}): Promise<ActionResult<{ liveId: string; liveTitle: string }>> {
  let target = "";
  const result = await runAction({ name: "startWebinarNow" }, async () => {
    const actor = await assertPermission("events.manage");
    const admin = createAdminClient();

    let who: Who | null = null;
    if (input.who) {
      who = parseWho(input.who);
      if (!who) throw new Error("Pick who it's for.");
    } else {
      const { data: cohorts } = await admin
        .from("cohorts")
        .select("id, starts_on, ends_on, status");
      const cohortId = pickDefaultCohort(
        (cohorts ?? []).map((c: any) => ({
          id: c.id,
          startsOn: c.starts_on,
          endsOn: c.ends_on,
          status: c.status,
        })),
      );
      who = cohortId ? { kind: "cohort", cohortId } : { kind: "public" };
    }
    await assertCohortExists(admin, who);
    const audience = audienceFor(who, null);

    const nowDate = new Date();
    if (!input.again) {
      const { data: running, error: runningError } = await admin
        .from("events")
        .select(
          "id, title, visibility, cohort_id, live_mode, starts_at, ends_at, live_started_at, live_ended_at",
        )
        .in("live_mode", ["hosted", "premiere"])
        .is("live_ended_at", null)
        .gte("starts_at", new Date(nowDate.getTime() - 24 * 60 * 60_000).toISOString())
        .order("starts_at", { ascending: true })
        .limit(200);
      if (runningError) throw new Error(runningError.message);
      const dup = liveForAudience(
        ((running ?? []) as any[]).map((r) => ({
          id: r.id as string,
          title: r.title as string,
          visibility: r.visibility as string,
          cohortId: (r.cohort_id as string | null) ?? null,
          liveMode: r.live_mode as string,
          startsAt: r.starts_at as string,
          endsAt: (r.ends_at as string | null) ?? null,
          liveStartedAt: (r.live_started_at as string | null) ?? null,
          liveEndedAt: null,
        })),
        audience,
        nowDate,
      );
      // Not an error: the dialog offers Join, or Start another.
      if (dup) return { liveId: dup.id, liveTitle: dup.title };
    }

    const startsAt = floorToMinute(nowDate).toISOString();
    const title =
      (input.title ?? "").trim().slice(0, MAX_TITLE_LENGTH) || DEFAULT_LIVE_TITLE;
    const { data, error } = await admin
      .from("events")
      .insert({
        type: "webinar",
        live_mode: "hosted",
        title,
        starts_at: startsAt,
        ends_at: endsAtFor(startsAt, DEFAULT_DURATION_MINUTES),
        visibility: audience.visibility,
        cohort_id: audience.cohort_id,
        audience_mode: DEFAULT_AUDIENCE_MODE,
        auto_record: true,
        auto_share: audience.visibility !== "staff",
        live_started_at: nowDate.toISOString(),
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (data as { id: string }).id;

    await logAudit({
      action: "event.created",
      targetType: "event",
      targetId: id,
      payload: { title, type: "webinar", startedNow: true, notify: input.notify },
    });
    revalidateEventViews();

    if (input.notify && audience.visibility !== "staff") {
      const { data: me } = await admin
        .from("profiles")
        .select("full_name")
        .eq("id", actor.userId)
        .maybeSingle();
      const hostName =
        ((me as { full_name?: string | null } | null)?.full_name ?? "").trim() || "batch0";
      const ev: NotifyEvent = {
        id,
        title,
        startsAt,
        visibility: audience.visibility,
        cohortId: audience.cohort_id,
        liveMode: "hosted",
        externalUrl: null,
      };
      after(() => announceLive(ev, hostName));
    }
    target = `/dashboard/events/${id}/live`;
    return undefined;
  });
  if (!result.ok || !target) return result;
  redirect(target);
}

/** Delete an event, its rows (cascade), its uploaded files and its recordings. */
export async function deleteEvent(id: string): Promise<ActionResult> {
  return runAction({ name: "deleteEvent" }, async () => {
    await assertPermission("events.manage");
    if (!isUuid(id)) throw new Error("That event no longer exists.");
    const admin = createAdminClient();
    const { data: event } = await admin
      .from("events")
      .select("id, title")
      .eq("id", id)
      .maybeSingle();
    if (!event) return;

    const { data: assets } = await admin
      .from("event_assets")
      .select("storage_path")
      .eq("event_id", id);
    const { error } = await admin.from("events").delete().eq("id", id);
    if (error) throw new Error(error.message);
    // After the row: a failed delete must not leave an event whose files or
    // recordings are gone. Both are best-effort and never throw.
    await removeObjects(
      admin,
      (assets ?? [])
        .map((a: any) => a.storage_path as string)
        .filter((p) => p.startsWith(`${id}/`)),
    );
    await deleteRoomRecordings("webinar", id);

    await logAudit({
      action: "event.deleted",
      targetType: "event",
      targetId: id,
      payload: { title: (event as { title: string }).title },
    });
    revalidateEventViews();
  });
}
