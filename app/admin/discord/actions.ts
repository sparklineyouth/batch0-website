"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import {
  postChannelMessage,
  getDiscordSettings,
  registerSlashCommands as discordRegisterCommands,
  syncMemberRoles,
  refreshDiscordIdentity,
  bootstrapGuildFromScratch,
  type BootstrapResult,
} from "@/lib/discord";
import type { Role } from "@/lib/types";

/**
 * Master kill-switch. When false, every Discord side effect short-
 * circuits and the student-facing Discord UI hides itself.
 */
export async function setDiscordEnabled(enabled: boolean) {
  await assertAdmin();
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
  await assertAdmin();
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
  await assertAdmin();
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
  await assertAdmin();
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
  await assertAdmin();
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
  await assertAdmin();
  if (confirm !== "DELETE AND REBUILD") {
    throw new Error('Type "DELETE AND REBUILD" exactly to confirm.');
  }
  const result = await bootstrapGuildFromScratch();
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const rows = [
    { key: "discord_channel_announcements_id", value: result.ids.announcementsChannelId },
    { key: "discord_channel_events_id", value: result.ids.eventsChannelId },
    { key: "discord_channel_admin_feed_id", value: result.ids.adminFeedChannelId },
    { key: "discord_channel_teams_category_id", value: result.ids.teamsCategoryId },
    { key: "discord_channel_wins_id", value: result.ids.winsChannelId },
    { key: "discord_channel_help_id", value: result.ids.helpChannelId },
    { key: "discord_channel_oh_voice_id", value: result.ids.ohVoiceChannelId },
    { key: "discord_channel_introductions_id", value: result.ids.introductionsChannelId },
    { key: "discord_role_student_id", value: result.ids.roleStudentId },
    { key: "discord_role_mentor_id", value: result.ids.roleMentorId },
    { key: "discord_role_admin_id", value: result.ids.roleAdminId },
    { key: "discord_role_investor_id", value: result.ids.roleInvestorId },
  ].map((r) => ({ ...r, updated_at: now }));
  const { error } = await admin
    .from("site_settings")
    .upsert(rows, { onConflict: "key" });
  if (error) throw new Error(`Saving IDs failed: ${error.message}`);
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
  await assertAdmin();
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
