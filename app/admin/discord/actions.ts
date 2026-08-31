"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import {
  postChannelMessage,
  getDiscordSettings,
  registerSlashCommands as discordRegisterCommands,
  syncMemberRoles,
  refreshDiscordIdentity,
  bootstrapGuildFromScratch,
  repairGuildLayout,
  setInteractionsEndpoint,
  type BootstrapResult,
  type RepairResult,
  type CanonicalLayoutIds,
} from "@/lib/discord";
import type { Role } from "@/lib/types";

/**
 * Master kill-switch. When false, every Discord side effect short-
 * circuits and the student-facing Discord UI hides itself.
 */
export async function setDiscordEnabled(enabled: boolean) {
  await assertPermission("discord.manage");
  const admin = createAdminClient();
  const { error } = await admin
    .from("site_settings")
    .upsert(
      {
        key: "discord_enabled",
        value: enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
  if (error) throw new Error(error.message);
  await logAudit({
    action: "discord.enabled_toggled",
    payload: { enabled },
  });
  revalidatePath("/admin/discord");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/community");
}

export type DiscordConfigInput = {
  announcementsChannelId: string;
  eventsChannelId: string;
  adminFeedChannelId: string;
  // 0033 feature-pack channels — all optional. When empty, the
  // associated feature silently no-ops (e.g. milestone check-ins won't
  // cross-post if winsChannelId is unset).
  teamsCategoryId: string;
  winsChannelId: string;
  helpChannelId: string;
  ohVoiceChannelId: string;
  introductionsChannelId: string;
  roleStudentId: string;
  roleMentorId: string;
  roleAdminId: string;
  roleInvestorId: string;
  // NOT one of the four role-mapped roles above, and deliberately listed apart
  // from them: syncMemberRoles() strips every role in roleIdByRole that isn't
  // the member's current target, so a founder pass filed alongside them would
  // be torn off holders on the next sync. See lib/discord.ts.
  roleFounderPassId: string;
};

const KEY_BY_FIELD: Record<keyof DiscordConfigInput, string> = {
  announcementsChannelId: "discord_channel_announcements_id",
  eventsChannelId: "discord_channel_events_id",
  adminFeedChannelId: "discord_channel_admin_feed_id",
  teamsCategoryId: "discord_channel_teams_category_id",
  winsChannelId: "discord_channel_wins_id",
  helpChannelId: "discord_channel_help_id",
  ohVoiceChannelId: "discord_channel_oh_voice_id",
  introductionsChannelId: "discord_channel_introductions_id",
  roleStudentId: "discord_role_student_id",
  roleMentorId: "discord_role_mentor_id",
  roleAdminId: "discord_role_admin_id",
  roleInvestorId: "discord_role_investor_id",
  roleFounderPassId: "discord_role_founder_pass_id",
};

function sanitizeSnowflake(v: string): string {
  // Discord snowflake = 17–20 digit base-10 integer string.
  const trimmed = v.trim();
  if (!trimmed) return "";
  if (!/^[0-9]{17,20}$/.test(trimmed)) {
    throw new Error(`"${v}" is not a valid Discord ID (17–20 digits)`);
  }
  return trimmed;
}

export async function saveDiscordConfig(input: DiscordConfigInput) {
  await assertPermission("discord.manage");
  const admin = createAdminClient();
  const rows = (Object.keys(KEY_BY_FIELD) as (keyof DiscordConfigInput)[]).map(
    (field) => ({
      key: KEY_BY_FIELD[field],
      value: sanitizeSnowflake(input[field]),
      updated_at: new Date().toISOString(),
    }),
  );
  const { error } = await admin
    .from("site_settings")
    .upsert(rows, { onConflict: "key" });
  if (error) throw new Error(error.message);
  await logAudit({
    action: "discord.config_updated",
    payload: rows.reduce(
      (acc, r) => ((acc[r.key] = r.value), acc),
      {} as Record<string, string>,
    ),
  });
  revalidatePath("/admin/discord");
}

/**
 * Push the SLASH_COMMANDS spec to Discord. PUT semantics — anything not
 * in the spec gets unregistered. Returns the names that are now live so
 * the UI can confirm.
 */
export async function registerCommands(): Promise<{ names: string[] }> {
  await assertPermission("discord.manage");
  const registered = await discordRegisterCommands();
  const names = registered.map((c) => c.name);
  await logAudit({
    action: "discord.commands_registered",
    payload: { names },
  });
  revalidatePath("/admin/discord");
  return { names };
}

/**
 * Re-apply each linked user's Discord roles based on their current
 * batch0 role. Useful after re-mapping role IDs, after a server
 * restore, or once a year as cohort cleanup.
 *
 * Throttled: at most ~5 mutations/second to stay clear of Discord's
 * per-route rate limit. We don't batch — sequential is simpler and the
 * link counts here are in the hundreds, not thousands.
 */
export async function resyncAllRoles(): Promise<{
  attempted: number;
  succeeded: number;
}> {
  await assertPermission("discord.manage");
  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("profiles")
    .select("id, discord_user_id, role")
    .not("discord_user_id", "is", null);
  if (error) throw new Error(error.message);
  let succeeded = 0;
  for (const row of rows ?? []) {
    const discordUserId = (row as any).discord_user_id as string;
    const role = ((row as any).role as Role) ?? "student";
    try {
      await syncMemberRoles(discordUserId, role);
      succeeded += 1;
    } catch (err) {
      console.error("[discord] resync failed for", discordUserId, err);
    }
    // Small delay to be polite to Discord's per-route rate limiter.
    await new Promise((r) => setTimeout(r, 200));
  }
  await logAudit({
    action: "discord.bulk_role_resync",
    payload: { attempted: rows?.length ?? 0, succeeded },
  });
  revalidatePath("/admin/discord");
  return { attempted: rows?.length ?? 0, succeeded };
}

/**
 * Refresh stored username/avatar for every linked user. Discord doesn't
 * push us username changes, so this gives admins a manual lever to keep
 * the UI honest.
 */
export async function refreshLinkedIdentities(): Promise<{
  attempted: number;
  succeeded: number;
}> {
  await assertPermission("discord.manage");
  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("profiles")
    .select("id, discord_user_id")
    .not("discord_user_id", "is", null);
  if (error) throw new Error(error.message);
  let succeeded = 0;
  for (const row of rows ?? []) {
    const did = (row as any).discord_user_id as string;
    const pid = (row as any).id as string;
    const ok = await refreshDiscordIdentity(pid, did);
    if (ok) succeeded += 1;
    await new Promise((r) => setTimeout(r, 150));
  }
  await logAudit({
    action: "discord.bulk_identity_refresh",
    payload: { attempted: rows?.length ?? 0, succeeded },
  });
  revalidatePath("/admin/discord");
  return { attempted: rows?.length ?? 0, succeeded };
}

/**
 * Write a freshly-built layout's channel + role IDs into site_settings.
 *
 * Shared by bootstrap and repair so the two can't drift. The founder-pass
 * role is in here deliberately: bootstrap used to rebuild the server
 * without it, which left discord_role_founder_pass_id pointing at a role
 * that no longer existed and silently broke the pass perk for every
 * redemption afterward.
 */
async function persistLayoutIds(ids: CanonicalLayoutIds) {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const rows = [
    { key: "discord_channel_announcements_id", value: ids.announcementsChannelId },
    { key: "discord_channel_events_id", value: ids.eventsChannelId },
    { key: "discord_channel_admin_feed_id", value: ids.adminFeedChannelId },
    { key: "discord_channel_teams_category_id", value: ids.teamsCategoryId },
    { key: "discord_channel_wins_id", value: ids.winsChannelId },
    { key: "discord_channel_help_id", value: ids.helpChannelId },
    { key: "discord_channel_oh_voice_id", value: ids.ohVoiceChannelId },
    { key: "discord_channel_introductions_id", value: ids.introductionsChannelId },
    { key: "discord_role_student_id", value: ids.roleStudentId },
    { key: "discord_role_mentor_id", value: ids.roleMentorId },
    { key: "discord_role_admin_id", value: ids.roleAdminId },
    { key: "discord_role_investor_id", value: ids.roleInvestorId },
    { key: "discord_role_founder_pass_id", value: ids.roleFounderPassId },
  ].map((r) => ({ ...r, updated_at: now }));
  const { error } = await admin
    .from("site_settings")
    .upsert(rows, { onConflict: "key" });
  if (error) throw new Error(`Saving IDs failed: ${error.message}`);
}

/**
 * Recreate whatever the canonical layout is missing and re-point
 * site_settings at what's actually in the guild — without deleting a
 * single thing.
 *
 * This is the fix for the failure the doctor reports as "Deleted or
 * wrong-guild" ids: channels or roles got removed in Discord, so every
 * stored ID now dangles and announcements, role sync, team channels and
 * the OH queue all fail silently. Until now the only repair on offer was
 * the destructive bootstrap, which is unusable on a server that has any
 * message history worth keeping.
 *
 * Safe to run repeatedly — anything already present under the canonical
 * name is adopted, not duplicated.
 */
export async function repairDiscordServer(): Promise<RepairResult> {
  await assertPermission("discord.manage");
  const result = await repairGuildLayout();
  await persistLayoutIds(result.ids);
  await logAudit({
    action: "discord.server_repaired",
    payload: {
      rolesCreated: result.rolesCreated.map((r) => r.name),
      rolesReused: result.rolesReused.length,
      channelsCreated: result.channelsCreated.map((c) => c.name),
      channelsReused: result.channelsReused.length,
    },
  });
  revalidatePath("/admin/discord");
  return result;
}

/**
 * Re-point the Discord application's interactions endpoint at this
 * deployment. One click instead of a trip to the developer portal — and
 * the only way to recover from a domain change without one.
 */
export async function fixInteractionsEndpoint(): Promise<{ url: string }> {
  await assertPermission("discord.manage");
  const result = await setInteractionsEndpoint();
  await logAudit({
    action: "discord.interactions_endpoint_set",
    payload: { url: result.url },
  });
  revalidatePath("/admin/discord");
  return result;
}

/**
 * Wipe every channel + every non-managed role in the guild, then create
 * the canonical batch0 layout (4 roles, 5 categories, ~14
 * channels) and persist the new channel/role IDs into site_settings so
 * the rest of the integration just works.
 *
 * Requires the literal phrase "DELETE AND REBUILD" as confirmation
 * because this is irreversible — all existing messages go with the
 * channels.
 */
export async function bootstrapDiscordServer(
  confirm: string,
): Promise<BootstrapResult> {
  await assertPermission("discord.manage");
  if (confirm !== "DELETE AND REBUILD") {
    throw new Error('Type "DELETE AND REBUILD" exactly to confirm.');
  }
  const result = await bootstrapGuildFromScratch();
  await persistLayoutIds(result.ids);
  await logAudit({
    action: "discord.server_bootstrapped",
    payload: {
      channelsDeleted: result.channelsDeleted,
      rolesDeleted: result.rolesDeleted,
      channelsCreated: result.channelsCreated.length,
      rolesCreated: result.rolesCreated.map((r) => r.name),
    },
  });
  revalidatePath("/admin/discord");
  return result;
}

/**
 * Drop a quick "hello from the website" message into any of the
 * configured channels — proves the bot has access and the channel id
 * is correct.
 */
export async function pingChannel(
  which: "announcements" | "events" | "admin_feed",
) {
  await assertPermission("discord.manage");
  const settings = await getDiscordSettings();
  const channelId =
    which === "announcements"
      ? settings.announcementsChannelId
      : which === "events"
        ? settings.eventsChannelId
        : settings.adminFeedChannelId;
  if (!channelId) throw new Error("No channel ID configured for this slot");
  const ok = await postChannelMessage(channelId, {
    content: `✅ \`/admin/discord\` test ping at ${new Date().toLocaleTimeString()}`,
  });
  if (!ok) throw new Error("Discord rejected the message — check bot perms");
}
