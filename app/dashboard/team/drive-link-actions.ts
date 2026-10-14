"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { runAction, type ActionResult } from "@/lib/action-result";
import {
  KIND_LABEL,
  cleanTitle,
  parseGoogleUrl,
  type GoogleKind,
} from "@/lib/google-drive-links";

/**
 * Writes for a team's Google Drive panel (public.team_drive_links, 0094).
 *
 * The table is read-only to signed-in users, so these service-role actions
 * are the only writers. Each one re-checks that the caller is on the team,
 * or holds teams.manage (the admin team page). A URL is never stored: it is
 * parsed against Google's exact hostnames and only its id parts are kept.
 */

const MAX_PINS = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_READY = "Google Drive isn't set up yet. Try again later.";

type Actor = { userId: string; asStaff: boolean };

async function authorize(teamId: unknown): Promise<Actor> {
  if (typeof teamId !== "string" || !UUID.test(teamId)) throw new Error("Team not found.");
  const actor = await requireActor();
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("team_members")
    .select("id")
    .eq("team_id", teamId)
    .eq("user_id", actor.userId)
    .maybeSingle();
  if (member) return { userId: actor.userId, asStaff: false };
  if (!can(actor.caps, "teams.manage")) throw new Error("You aren't on this team.");
  const { data: team } = await admin.from("teams").select("id").eq("id", teamId).maybeSingle();
  if (!team) throw new Error("Team not found.");
  return { userId: actor.userId, asStaff: true };
}

async function throttle(userId: string) {
  const rl = await checkRateLimit({
    kind: "team-drive-link",
    identifier: userId,
    limit: 30,
    windowSeconds: 60,
  });
  if (!rl.ok) throw new Error("Too many changes. Wait a minute.");
}

function dbError(error: { code?: string; message?: string }, context: string): never {
  if (isMissingSchemaError(error)) throw new Error(NOT_READY);
  if (error.code === "23505") throw new Error("Already pinned.");
  console.error(`[drive-links] ${context}`, error);
  throw new Error("Couldn't save. Try again.");
}

async function finish(actor: Actor, teamId: string, action: string, payload: Record<string, unknown>) {
  if (actor.asStaff) {
    await logAudit({ action, targetType: "team", targetId: teamId, payload });
  }
  revalidatePath("/dashboard/team");
  revalidatePath(`/admin/teams/${teamId}`);
  revalidatePath(`/mentor/teams/${teamId}`);
}

/** Link (or replace) the team's Google Drive folder. */
export async function setTeamFolder(input: { teamId: string; url: string }): Promise<ActionResult> {
  return runAction({ name: "setTeamFolder" }, async () => {
    const actor = await authorize(input?.teamId);
    await throttle(actor.userId);
    const link = parseGoogleUrl(input.url, { prefer: "folder" });
    if (!link || link.kind !== "folder") {
      throw new Error("Paste a Google Drive folder link.");
    }
    const admin = createAdminClient();
    const { data: existing, error: readErr } = await admin
      .from("team_drive_links")
      .select("id")
      .eq("team_id", input.teamId)
      .eq("is_folder_root", true)
      .maybeSingle();
    if (readErr) dbError(readErr, "read folder");
    const fields = {
      kind: "folder",
      google_id: link.id,
      resource_key: link.resourceKey,
      published: false,
      gid: null,
      title: "Team folder",
      created_by: actor.userId,
    };
    const { error } = existing
      ? await admin.from("team_drive_links").update(fields).eq("id", existing.id)
      : await admin
          .from("team_drive_links")
          .insert({ ...fields, team_id: input.teamId, is_folder_root: true });
    if (error) dbError(error, "set folder");
    await finish(actor, input.teamId, "team.drive.folder_set", { google_id: link.id });
  });
}

/** Unlink the team's folder. Nothing in Google Drive changes. */
export async function clearTeamFolder(input: { teamId: string }): Promise<ActionResult> {
  return runAction({ name: "clearTeamFolder" }, async () => {
    const actor = await authorize(input?.teamId);
    await throttle(actor.userId);
    const { error } = await createAdminClient()
      .from("team_drive_links")
      .delete()
      .eq("team_id", input.teamId)
      .eq("is_folder_root", true);
    if (error) dbError(error, "clear folder");
    await finish(actor, input.teamId, "team.drive.folder_cleared", {});
  });
}

/** Pin a Doc, Sheet, Slides, Form, Drawing, Drive file or subfolder. */
export async function addTeamPin(input: {
  teamId: string;
  url: string;
  title?: string;
}): Promise<ActionResult> {
  return runAction({ name: "addTeamPin" }, async () => {
    const actor = await authorize(input?.teamId);
    await throttle(actor.userId);
    const link = parseGoogleUrl(input.url);
    if (!link) throw new Error("Paste a Google Docs, Sheets, Slides, Forms or Drive link.");
    const admin = createAdminClient();
    const { data: pins, error: readErr } = await admin
      .from("team_drive_links")
      .select("position")
      .eq("team_id", input.teamId)
      .eq("is_folder_root", false);
    if (readErr) dbError(readErr, "read pins");
    if ((pins ?? []).length >= MAX_PINS) throw new Error(`Up to ${MAX_PINS} pins.`);
    const position = Math.max(-1, ...(pins ?? []).map((p: any) => p.position ?? 0)) + 1;
    const { error } = await admin.from("team_drive_links").insert({
      team_id: input.teamId,
      kind: link.kind,
      google_id: link.id,
      resource_key: link.resourceKey,
      published: link.published,
      gid: link.gid,
      title: cleanTitle(input.title, KIND_LABEL[link.kind]),
      is_folder_root: false,
      position,
      created_by: actor.userId,
    });
    if (error) dbError(error, "add pin");
    await finish(actor, input.teamId, "team.drive.pin_added", { kind: link.kind, google_id: link.id });
  });
}

async function loadPin(id: unknown) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Pin not found.");
  const { data, error } = await createAdminClient()
    .from("team_drive_links")
    .select("id, team_id, kind, is_folder_root")
    .eq("id", id)
    .maybeSingle();
  if (error) dbError(error, "read pin");
  if (!data || data.is_folder_root) throw new Error("Pin not found.");
  return data as { id: string; team_id: string; kind: GoogleKind };
}

export async function renameTeamPin(input: { id: string; title: string }): Promise<ActionResult> {
  return runAction({ name: "renameTeamPin" }, async () => {
    const pin = await loadPin(input?.id);
    const actor = await authorize(pin.team_id);
    await throttle(actor.userId);
    const title = cleanTitle(input.title, KIND_LABEL[pin.kind] ?? "Link");
    const { error } = await createAdminClient()
      .from("team_drive_links")
      .update({ title })
      .eq("id", pin.id);
    if (error) dbError(error, "rename pin");
    await finish(actor, pin.team_id, "team.drive.pin_renamed", { id: pin.id });
  });
}

export async function removeTeamPin(input: { id: string }): Promise<ActionResult> {
  return runAction({ name: "removeTeamPin" }, async () => {
    const pin = await loadPin(input?.id);
    const actor = await authorize(pin.team_id);
    await throttle(actor.userId);
    const { error } = await createAdminClient()
      .from("team_drive_links")
      .delete()
      .eq("id", pin.id)
      .eq("is_folder_root", false);
    if (error) dbError(error, "remove pin");
    await finish(actor, pin.team_id, "team.drive.pin_removed", { id: pin.id });
  });
}
