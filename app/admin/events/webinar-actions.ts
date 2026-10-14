"use server";
import { revalidatePath } from "next/cache";
import { randomBytes, randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { resolveEventAccess } from "@/lib/live-access";
import { type EventAsset, type EventSpeaker } from "@/lib/webinars";
import { listAssets, listSpeakers } from "@/lib/webinar-data";
import { runAction, type ActionResult } from "@/lib/action-result";
import { isUuid, parseHttpUrl } from "@/lib/event-form";
import { isDeckPathFor, mintDeckUpload, removeObjects } from "./deck";

/**
 * Server actions for a webinar's slides and its guest speakers. Slides are
 * staff-only, from the event form: an action mints a signed URL and the
 * browser PUTs to Storage, so the bytes never pass through a function. Guest
 * speakers: staff edit the list; a guest claims a slot on the way in.
 * Recordings are not files here: they are takes in `recording_sessions`,
 * uploaded through /api/recordings.
 */

/**
 * Authorize a write against one webinar: staff (`events.manage`) only.
 *
 * Through `resolveEventAccess` (lib/live-access.ts), the one place the host
 * rule is computed, so the event must also exist and be visible to the caller
 * (staff always see it).
 */
async function gateWrite(eventId: string): Promise<{ userId: string }> {
  const access = await resolveEventAccess(eventId);
  if (!access.ok) {
    throw new Error(
      access.reason === "error" ? "Couldn't reach the server — try again." : "Forbidden",
    );
  }
  if (!access.isStaff) throw new Error("Forbidden");
  return { userId: access.userId };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * A signed URL for one PDF deck. Staff only. `eventId` null means a new event
 * that doesn't exist yet: its id is minted here and the form saves the event
 * under it, so slides can be picked before the first Save.
 */
export async function getDeckUploadToken(
  eventId: string | null,
  filename: string,
): Promise<
  ActionResult<{ eventId: string; path: string; token: string; signedUrl: string }>
> {
  return runAction({ name: "getDeckUploadToken" }, async () => {
    await assertPermission("events.manage");
    if (eventId !== null && !isUuid(eventId)) throw new Error("Open the form again.");
    const id = eventId ?? randomUUID();
    return { eventId: id, ...(await mintDeckUpload(id, filename)) };
  });
}

/** Throw away slides picked in the form but never saved. Staff only. */
export async function discardDeckUpload(
  eventId: string,
  storagePath: string,
): Promise<ActionResult> {
  return runAction({ name: "discardDeckUpload" }, async () => {
    await assertPermission("events.manage");
    if (!isUuid(eventId) || !isDeckPathFor(eventId, storagePath)) return;
    const admin = createAdminClient();
    // Never delete bytes a saved row points at.
    const { data, error } = await admin
      .from("event_assets")
      .select("id")
      .eq("storage_path", storagePath)
      .limit(1);
    if (error || (data ?? []).length > 0) return;
    await removeObjects(admin, [storagePath]);
  });
}

/** Detach a file and delete the bytes. Staff only. */
export async function removeWebinarAsset(
  eventId: string,
  assetId: string,
): Promise<ActionResult> {
  return runAction({ name: "removeWebinarAsset" }, async () => {
    await gateWrite(eventId);
    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("event_assets")
      .select("storage_path, kind, filename")
      .eq("id", assetId)
      .eq("event_id", eventId)
      .maybeSingle();
    if (!existing) return;

    // Bytes first: the row is the only record of the path.
    await removeObjects(admin, [(existing as any).storage_path]);
    const { error } = await admin
      .from("event_assets")
      .delete()
      .eq("id", assetId)
      .eq("event_id", eventId);
    if (error) throw new Error(error.message);

    await logAudit({
      action: "event.asset_removed",
      targetType: "event",
      targetId: eventId,
      payload: { filename: (existing as any).filename },
    });
    revalidatePath("/admin/events");
  });
}

/**
 * An existing event's speakers and slides, for the edit form. Read on demand,
 * not with the list. The form must not save speakers until this has landed:
 * `saveSpeakers` replaces the whole list.
 */
export async function fetchWebinarExtras(eventId: string): Promise<
  ActionResult<{ speakers: EventSpeaker[]; deck: EventAsset | null }>
> {
  return runAction({ name: "fetchWebinarExtras" }, async () => {
    await assertPermission("events.manage");
    const [speakers, assets] = await Promise.all([
      listSpeakers(eventId, true),
      listAssets(eventId),
    ]);
    const decks = assets.filter((a) => a.kind === "deck");
    return { speakers, deck: decks[decks.length - 1] ?? null };
  });
}

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

export type SpeakerInput = {
  id?: string;
  name: string;
  title: string | null;
  bio: string | null;
  email: string | null;
  photoUrl: string | null;
  linkUrl: string | null;
  sortOrder: number;
};

/**
 * Replace an event's speaker list.
 *
 * Whole-list rather than per-row, because the form edits it as a list — rows
 * are added, removed and reordered together, and three round trips to express
 * one save is how a list ends up half-applied when the third one fails.
 *
 * Rows that survive are matched by id and UPDATED, not deleted and re-inserted.
 * That matters: the id is what a claimed speaker's `user_id` hangs off, and
 * re-creating the row would silently revoke a guest's access mid-webinar
 * because an admin fixed a typo in their job title.
 */
export async function saveSpeakers(
  eventId: string,
  speakers: SpeakerInput[],
): Promise<ActionResult<EventSpeaker[]>> {
  return runAction({ name: "saveSpeakers" }, async () => {
    await gateWrite(eventId);
    const admin = createAdminClient();

    const clean = speakers
      .map((s, i) => ({ ...s, sortOrder: i }))
      .filter((s) => s.name.trim().length > 0)
      .slice(0, 20);
    for (const s of clean) {
      if (s.id && !isUuid(s.id)) throw new Error("Reload and try again.");
      if (!parseHttpUrl(s.linkUrl).ok) {
        throw new Error(`${s.name.trim()}: use a full https:// link.`);
      }
    }

    const keep = clean.map((s) => s.id).filter(Boolean) as string[];
    let del = admin.from("event_speakers").delete().eq("event_id", eventId);
    if (keep.length > 0) del = del.not("id", "in", `(${keep.join(",")})`);
    const { error: delError } = await del;
    if (delError) throw new Error(delError.message);

    for (const s of clean) {
      const payload = {
        event_id: eventId,
        name: s.name.trim().slice(0, 120),
        title: s.title?.trim().slice(0, 160) || null,
        bio: s.bio?.trim().slice(0, 1000) || null,
        email: s.email?.trim().toLowerCase() || null,
        photo_url: s.photoUrl?.trim() || null,
        link_url: (parseHttpUrl(s.linkUrl) as { url: string | null }).url,
        sort_order: s.sortOrder,
      };
      if (s.id) {
        const { error } = await admin
          .from("event_speakers")
          .update(payload)
          .eq("id", s.id)
          .eq("event_id", eventId);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await admin.from("event_speakers").insert({
          ...payload,
          // Minted on creation so the invite link exists the moment the row does.
          // 32 bytes of base64url — this is the only credential in the feature
          // that is guessable in principle, so it is sized to make that
          // impossible in practice rather than merely unlikely.
          claim_token: randomBytes(32).toString("base64url"),
        });
        if (error) throw new Error(error.message);
      }
    }

    await logAudit({
      action: "event.speakers_updated",
      targetType: "event",
      targetId: eventId,
      payload: { count: clean.length },
    });
    revalidatePath("/admin/events");
    return listSpeakers(eventId, true);
  });
}

/**
 * The link a guest opens to become a speaker.
 *
 * Minted on demand rather than returned with the speaker list, so a live token
 * exists only in the moment an admin is copying it. `listSpeakers` never
 * selects the column at all, and migration 0084 revokes it from `authenticated`
 * outright — a student who could read a token could claim the slot and, through
 * `credentialsFor`, walk out with the room's audience list.
 */
export async function speakerInviteLink(
  eventId: string,
  speakerId: string,
): Promise<ActionResult<string>> {
  return runAction({ name: "speakerInviteLink" }, async () => {
    await gateWrite(eventId);
    const admin = createAdminClient();
    const { data } = await admin
      .from("event_speakers")
      .select("claim_token")
      .eq("id", speakerId)
      .eq("event_id", eventId)
      .maybeSingle();
    const token = (data as any)?.claim_token;
    if (!token) throw new Error("That speaker has already claimed their slot.");
    return inviteUrlFor(eventId, token);
  });
}
function inviteUrlFor(eventId: string, token: string): string {
  return `${env.siteUrl}/dashboard/events/${eventId}/live?speaker=${token}`;
}

/**
 * Email a guest their claim link. Staff only.
 *
 * The form has always said the speaker's email is "where the invite goes", and
 * the template has always existed — but nothing sent it, so a guest could only
 * ever get in if an admin copied the link out by hand (and there was no button
 * for that either). Sent to the address on the speaker row, never to one the
 * client supplies, and refused once the slot is claimed: a spent token cannot
 * be re-sent, and a claimed guest needs no link.
 */
export async function sendSpeakerInvite(
  eventId: string,
  speakerId: string,
): Promise<ActionResult> {
  return runAction({ name: "sendSpeakerInvite" }, async () => {
    const { userId } = await gateWrite(eventId);
    const admin = createAdminClient();
    const [{ data: speaker }, { data: event }, { data: me }] = await Promise.all([
      admin
        .from("event_speakers")
        .select("id, name, email, claim_token, user_id")
        .eq("id", speakerId)
        .eq("event_id", eventId)
        .maybeSingle(),
      admin
        .from("events")
        .select("title, starts_at")
        .eq("id", eventId)
        .maybeSingle(),
      admin.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
    ]);
    const sp = speaker as any;
    if (!sp) throw new Error("That speaker isn't on this event.");
    if (sp.user_id || !sp.claim_token) {
      throw new Error("That speaker has already claimed their slot.");
    }
    if (!sp.email) throw new Error("Add an email for this speaker first.");
    if (!event) throw new Error("That event no longer exists.");

    const t = Templates.speakerInvite({
      eventTitle: (event as any).title,
      startsAt: (event as any).starts_at,
      inviteUrl: inviteUrlFor(eventId, sp.claim_token),
      hostName: (me as any)?.full_name || "The batch0 team",
    });
    await sendEmail({ to: sp.email, subject: t.subject, html: t.html });

    await logAudit({
      action: "event.speaker_invited",
      targetType: "event",
      targetId: eventId,
      payload: { speakerId },
    });
  });
}

/**
 * Claim a speaker slot.
 *
 * Deliberately a CLAIM and not an authentication. The caller must already be a
 * signed-in batch0 user — this is not a way around the auth wall — and all the
 * token does is attach that existing account to a row an admin already created.
 * It is spent on first use, so a forwarded link fails closed rather than
 * handing a second person a camera.
 *
 * Returns quietly rather than throwing on a bad token. This runs on the way
 * into the live page for anyone arriving with a `?speaker=` parameter, and a
 * stale link — the common case, since the token is cleared on claim and the
 * guest will reload that URL — must not turn the webinar into an error page.
 *
 * Staff never claim. They host every webinar through `events.manage` and need
 * no speaker row — and the obvious way to check a "Copy invite link" is to
 * open it in your own signed-in browser. That used to bind the guest's slot
 * to the admin and spend the token: the real guest's link was dead (and
 * neither Copy nor Send will mint one for a claimed row), and the admin,
 * now on the speaker list, was treated as a guest by everything that told
 * staff from speakers that way. So a staff caller is a no-op here and the
 * link survives for the guest it was made for.
 */
export async function claimSpeakerSlot(
  eventId: string,
  token: string,
): Promise<boolean> {
  const actor = await requireActor();
  if (!token || token.length < 16) return false;
  if (can(actor.caps, "events.manage")) return false;
  const admin = createAdminClient();

  // Conditional on the token still being present, so two people racing the
  // same link converge on one winner: the second update matches no row.
  const { data, error } = await admin
    .from("event_speakers")
    .update({ user_id: actor.userId, claim_token: null })
    .eq("event_id", eventId)
    .eq("claim_token", token)
    .is("user_id", null)
    .select("id")
    .maybeSingle();
  if (error || !data) return false;

  await logAudit({
    action: "event.speaker_claimed",
    targetType: "event",
    targetId: eventId,
    payload: { speakerId: (data as any).id },
  });
  return true;
}
