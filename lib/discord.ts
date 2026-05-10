import { env } from "@/lib/env";

const API = "https://discord.com/api/v10";

/**
 * Post a message to a Discord channel via webhook URL. No-ops if no
 * webhook is configured. Failures are swallowed.
 */
export async function postDiscordWebhook(args: {
  webhookUrl?: string;
  content?: string;
  embeds?: Record<string, any>[];
  username?: string;
}): Promise<boolean> {
  const url = args.webhookUrl ?? env.discordAnnouncementsWebhook;
  if (!url) {
    console.warn("[discord] no webhook configured; would have posted");
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: args.content,
        embeds: args.embeds,
        username: args.username ?? "SparkLine",
        allowed_mentions: { parse: [] },
      }),
    });
    if (!res.ok) {
      console.error("[discord] webhook error", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[discord] webhook failed", err);
    return false;
  }
}

/**
 * Grant a Discord role to a member. Requires DISCORD_BOT_TOKEN +
 * DISCORD_GUILD_ID + DISCORD_ROLE_STUDENT in env, AND the user must
 * have already joined the server (we don't auto-join — that requires
 * full OAuth which is out of scope here).
 */
export async function grantStudentRole(discordUserId: string): Promise<boolean> {
  if (
    !env.discordBotToken ||
    !env.discordGuildId ||
    !env.discordRoleStudent
  ) {
    console.warn("[discord] role grant skipped: bot token or IDs not set");
    return false;
  }
  try {
    const res = await fetch(
      `${API}/guilds/${env.discordGuildId}/members/${discordUserId}/roles/${env.discordRoleStudent}`,
      {
        method: "PUT",
        headers: { Authorization: `Bot ${env.discordBotToken}` },
      },
    );
    if (!res.ok && res.status !== 204) {
      console.error("[discord] role grant error", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[discord] role grant failed", err);
    return false;
  }
}
