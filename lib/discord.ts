import { webcrypto } from "crypto";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Role } from "@/lib/types";

const API = "https://discord.com/api/v10";

// ---------------------------------------------------------------------------
// Master kill-switch. Admins can flip this in /admin/discord to pause the
// whole integration without redeploying or pulling env vars.
//
// IMPORTANT: every helper that touches Discord short-circuits when this is
// false, so callers don't need to remember to check. UI gating reads the
// same flag via getDiscordSettings().enabled.
// ---------------------------------------------------------------------------
export async function isDiscordEnabled(): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("site_settings")
      .select("value")
      .eq("key", "discord_enabled")
      .maybeSingle();
    // Default to enabled if the key isn't seeded yet — preserves prior
    // behavior between deploys.
    if (!data) return true;
    return data.value !== false && data.value !== "false";
  } catch (err) {
    console.error("[discord] enabled check failed", err);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Webhook posting (legacy — still used for the announcements channel +
// new-enrollment trumpet). Failures are swallowed.
// ---------------------------------------------------------------------------
export async function postDiscordWebhook(args: {
  webhookUrl?: string;
  content?: string;
  embeds?: Record<string, any>[];
  username?: string;
}): Promise<boolean> {
  if (!(await isDiscordEnabled())) return false;
  const url = args.webhookUrl ?? env.discordAnnouncementsWebhook;
  if (!url) return false;
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

// ---------------------------------------------------------------------------
// Settings: channel + role IDs are admin-configurable via site_settings so
// staff can re-target them without redeploying. We cache nothing — these
// values change rarely and the queries are cheap.
// ---------------------------------------------------------------------------
export type DiscordSettings = {
  enabled: boolean;
  announcementsChannelId: string;
  eventsChannelId: string;
  adminFeedChannelId: string;
  roleIdByRole: Partial<Record<Role, string>>;
};

const SETTING_KEYS = [
  "discord_enabled",
  "discord_channel_announcements_id",
  "discord_channel_events_id",
  "discord_channel_admin_feed_id",
  "discord_role_student_id",
  "discord_role_mentor_id",
  "discord_role_admin_id",
  "discord_role_investor_id",
] as const;

export async function getDiscordSettings(): Promise<DiscordSettings> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("site_settings")
    .select("key, value")
    .in("key", SETTING_KEYS as unknown as string[]);
  const map = new Map<string, unknown>();
  for (const row of data ?? []) {
    map.set(row.key, row.value);
  }
  const rawEnabled = map.get("discord_enabled");
  const enabled =
    rawEnabled === undefined
      ? true
      : rawEnabled !== false && rawEnabled !== "false";
  const str = (k: string) => {
    const v = map.get(k);
    return typeof v === "string" ? v : "";
  };
  return {
    enabled,
    announcementsChannelId: str("discord_channel_announcements_id"),
    eventsChannelId: str("discord_channel_events_id"),
    adminFeedChannelId: str("discord_channel_admin_feed_id"),
    roleIdByRole: {
      student: str("discord_role_student_id") || env.discordRoleStudent || "",
      mentor: str("discord_role_mentor_id"),
      admin: str("discord_role_admin_id"),
      investor: str("discord_role_investor_id"),
    },
  };
}

// ---------------------------------------------------------------------------
// OAuth: exchange a code for user tokens, fetch the user, add them to the
// guild. Caller stores the link on the profile.
// ---------------------------------------------------------------------------
export type DiscordTokenSet = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

export type DiscordUser = {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
};

export async function exchangeOauthCode(
  code: string,
  redirectUri: string,
): Promise<DiscordTokenSet> {
  if (!env.discordClientId || !env.discordClientSecret) {
    throw new Error("Discord OAuth is not configured");
  }
  const body = new URLSearchParams({
    client_id: env.discordClientId,
    client_secret: env.discordClientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Discord token exchange failed: ${res.status} ${t}`);
  }
  return (await res.json()) as DiscordTokenSet;
}

/**
 * Revokes a Discord OAuth token so a stolen callback URL can't grant a
 * lingering access window. We only ever needed the token long enough to
 * read /users/@me + drop the user in the guild; once linking is done we
 * have no reason to keep it valid.
 *
 * Best-effort — Discord returns 200 on success; we swallow errors so a
 * temporary outage doesn't reverse a successful link.
 */
export async function revokeOauthToken(token: string): Promise<void> {
  if (!env.discordClientId || !env.discordClientSecret || !token) return;
  try {
    const body = new URLSearchParams({
      client_id: env.discordClientId,
      client_secret: env.discordClientSecret,
      token,
    });
    await fetch(`${API}/oauth2/token/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    console.error("[discord] token revoke failed", err);
  }
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Discord /users/@me failed: ${res.status}`);
  }
  return (await res.json()) as DiscordUser;
}

/**
 * Add (or update) a member in the guild. Uses the `guilds.join` OAuth
 * scope on the user's access token plus the bot token. Idempotent —
 * Discord returns 204 if the user is already a member.
 */
export async function addMemberToGuild(args: {
  discordUserId: string;
  accessToken: string;
  roleIds?: string[];
  nick?: string;
}): Promise<boolean> {
  if (!(await isDiscordEnabled())) return false;
  if (!env.discordBotToken || !env.discordGuildId) return false;
  try {
    const res = await fetch(
      `${API}/guilds/${env.discordGuildId}/members/${args.discordUserId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${env.discordBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          access_token: args.accessToken,
          roles: (args.roleIds ?? []).filter(Boolean),
          nick: args.nick,
        }),
      },
    );
    // 201 = added, 204 = already in. Either is success.
    return res.ok || res.status === 204;
  } catch (err) {
    console.error("[discord] add member failed", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Guild operations via bot token.
// ---------------------------------------------------------------------------
export async function fetchGuildMember(discordUserId: string) {
  if (!(await isDiscordEnabled())) return null;
  if (!env.discordBotToken || !env.discordGuildId) return null;
  try {
    const res = await fetch(
      `${API}/guilds/${env.discordGuildId}/members/${discordUserId}`,
      { headers: { Authorization: `Bot ${env.discordBotToken}` } },
    );
    if (!res.ok) return null;
    return (await res.json()) as { roles: string[]; nick: string | null };
  } catch {
    return null;
  }
}

export async function addRoleToMember(
  discordUserId: string,
  roleId: string,
): Promise<boolean> {
  if (!(await isDiscordEnabled())) return false;
  if (!env.discordBotToken || !env.discordGuildId || !roleId) return false;
  try {
    const res = await fetch(
      `${API}/guilds/${env.discordGuildId}/members/${discordUserId}/roles/${roleId}`,
      {
        method: "PUT",
        headers: { Authorization: `Bot ${env.discordBotToken}` },
      },
    );
    return res.ok || res.status === 204;
  } catch (err) {
    console.error("[discord] add role failed", err);
    return false;
  }
}

export async function removeRoleFromMember(
  discordUserId: string,
  roleId: string,
): Promise<boolean> {
  if (!(await isDiscordEnabled())) return false;
  if (!env.discordBotToken || !env.discordGuildId || !roleId) return false;
  try {
    const res = await fetch(
      `${API}/guilds/${env.discordGuildId}/members/${discordUserId}/roles/${roleId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bot ${env.discordBotToken}` },
      },
    );
    return res.ok || res.status === 204;
  } catch (err) {
    console.error("[discord] remove role failed", err);
    return false;
  }
}

/**
 * Make a member's Discord roles match the user's SparkLine role.
 * Adds the role mapped to their current SparkLine role, removes any
 * other SparkLine-managed roles they had. Safe to call repeatedly.
 */
export async function syncMemberRoles(
  discordUserId: string,
  role: Role,
): Promise<void> {
  if (!env.discordBotToken || !env.discordGuildId) return;
  const settings = await getDiscordSettings();
  if (!settings.enabled) return;
  const managedRoleIds = Object.values(settings.roleIdByRole).filter(
    Boolean,
  ) as string[];
  const targetRoleId = settings.roleIdByRole[role];
  for (const rid of managedRoleIds) {
    if (rid === targetRoleId) continue;
    await removeRoleFromMember(discordUserId, rid);
  }
  if (targetRoleId) {
    await addRoleToMember(discordUserId, targetRoleId);
  }
}

export async function kickFromGuild(discordUserId: string): Promise<boolean> {
  if (!(await isDiscordEnabled())) return false;
  if (!env.discordBotToken || !env.discordGuildId) return false;
  try {
    const res = await fetch(
      `${API}/guilds/${env.discordGuildId}/members/${discordUserId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bot ${env.discordBotToken}` },
      },
    );
    return res.ok || res.status === 204;
  } catch (err) {
    console.error("[discord] kick failed", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Channel messaging via bot token (replaces webhook for richer routing).
// ---------------------------------------------------------------------------
export async function postChannelMessage(
  channelId: string,
  payload: {
    content?: string;
    embeds?: Record<string, any>[];
  },
): Promise<boolean> {
  if (!(await isDiscordEnabled())) return false;
  if (!env.discordBotToken || !channelId) return false;
  try {
    const res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...payload,
        allowed_mentions: { parse: [] },
      }),
    });
    if (!res.ok) {
      console.error("[discord] channel post failed", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[discord] channel post error", err);
    return false;
  }
}

const BRAND_COLOR = 0xfacc15; // tailwind yellow-400, matches the spark token

export function announcementEmbed(args: {
  title: string;
  body: string;
  cohortName?: string | null;
  link?: string | null;
}) {
  return {
    title: args.title,
    description: args.body.slice(0, 2000),
    color: BRAND_COLOR,
    url: args.link ?? undefined,
    footer: {
      text: args.cohortName
        ? `SparkLine · ${args.cohortName}`
        : "SparkLine",
    },
    timestamp: new Date().toISOString(),
  };
}

export function eventEmbed(args: {
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  zoomUrl: string | null;
  type: string;
  cohortName?: string | null;
}) {
  const start = new Date(args.startsAt);
  const epoch = Math.floor(start.getTime() / 1000);
  const desc: string[] = [];
  if (args.description) desc.push(args.description);
  desc.push(`\n🗓️ <t:${epoch}:F> (<t:${epoch}:R>)`);
  if (args.location) desc.push(`📍 ${args.location}`);
  if (args.zoomUrl) desc.push(`🔗 [Join link](${args.zoomUrl})`);
  return {
    title: `${prettyEventType(args.type)} · ${args.title}`,
    description: desc.join("\n"),
    color: BRAND_COLOR,
    footer: {
      text: args.cohortName ? `SparkLine · ${args.cohortName}` : "SparkLine",
    },
    timestamp: new Date().toISOString(),
  };
}

function prettyEventType(t: string) {
  switch (t) {
    case "demo_day":
      return "🚀 Demo Day";
    case "office_hours":
      return "💬 Office Hours";
    case "workshop":
      return "🛠️ Workshop";
    default:
      return "📌 Event";
  }
}

// ---------------------------------------------------------------------------
// Interaction signature verification (Ed25519). Discord re-pings the
// endpoint with random payloads — we MUST verify or registration
// fails.
// ---------------------------------------------------------------------------
export async function verifyInteractionSignature(
  rawBody: string,
  signatureHex: string | null,
  timestamp: string | null,
): Promise<boolean> {
  if (!env.discordPublicKey || !signatureHex || !timestamp) return false;
  try {
    const enc = new TextEncoder();
    const key = await webcrypto.subtle.importKey(
      "raw",
      hexToBytes(env.discordPublicKey),
      { name: "Ed25519" } as unknown as AlgorithmIdentifier,
      false,
      ["verify"],
    );
    const data = new Uint8Array([
      ...enc.encode(timestamp),
      ...enc.encode(rawBody),
    ]);
    return await webcrypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signatureHex),
      data,
    );
  } catch (err) {
    console.error("[discord] signature verify error", err);
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Convenience: avatar URL (small) for display in the UI.
export function discordAvatarUrl(
  userId: string | null,
  avatar: string | null,
  size = 64,
): string | null {
  if (!userId || !avatar) return null;
  return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png?size=${size}`;
}
