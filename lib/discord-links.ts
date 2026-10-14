/**
 * discord.com deep links. Built only from ids shaped like Discord snowflakes
 * (17–20 digits), so a malformed or hostile value can never shape the URL;
 * anything else gives null and the caller shows no link.
 *
 * Import-free so `node --test` can run lib/discord-links.test.ts directly.
 */

const SNOWFLAKE = /^\d{17,20}$/;

export function isSnowflake(id: unknown): id is string {
  return typeof id === "string" && SNOWFLAKE.test(id);
}

/** https://discord.com/channels/<guild>/<channel>, or null. */
export function discordChannelUrl(
  guildId: string | null | undefined,
  channelId: string | null | undefined,
): string | null {
  if (!isSnowflake(guildId) || !isSnowflake(channelId)) return null;
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

/** https://discord.com/channels/<guild>/<channel>/<message>, or null. */
export function discordMessageUrl(
  guildId: string | null | undefined,
  channelId: string | null | undefined,
  messageId: string | null | undefined,
): string | null {
  const channel = discordChannelUrl(guildId, channelId);
  if (!channel || !isSnowflake(messageId)) return null;
  return `${channel}/${messageId}`;
}
