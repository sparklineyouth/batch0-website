"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { postChannelMessage, getDiscordSettings } from "@/lib/discord";

export type DiscordConfigInput = {
  announcementsChannelId: string;
  eventsChannelId: string;
  adminFeedChannelId: string;
  roleStudentId: string;
  roleMentorId: string;
  roleAdminId: string;
  roleInvestorId: string;
};

const KEY_BY_FIELD: Record<keyof DiscordConfigInput, string> = {
  announcementsChannelId: "discord_channel_announcements_id",
  eventsChannelId: "discord_channel_events_id",
  adminFeedChannelId: "discord_channel_admin_feed_id",
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
