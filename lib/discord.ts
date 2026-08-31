import { webcrypto } from "crypto";
import { cache } from "react";
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
//
// React-cached: one flow can hit the gate several times (each helper checks
// it), and one settings read per request covers them all. The cache never
// outlives the request, so a flip still takes effect on the very next one.
// ---------------------------------------------------------------------------
export const isDiscordEnabled = cache(async (): Promise<boolean> => {
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
});

// ---------------------------------------------------------------------------
// Webhook posting (legacy — still used for the announcements channel +
// new-enrollment trumpet). Failures are swallowed.
// ---------------------------------------------------------------------------
/**
 * Discord `allowed_mentions` object — gates which mentions in `content`
 * actually ping. Default everywhere is "no pings"; callers that need
 * @everyone or a role ping must opt in explicitly.
 *   https://discord.com/developers/docs/resources/channel#allowed-mentions-object
 */
export type AllowedMentions = {
  parse?: ("everyone" | "users" | "roles")[];
  roles?: string[];
  users?: string[];
};

export async function postDiscordWebhook(args: {
  webhookUrl?: string;
  content?: string;
  embeds?: Record<string, any>[];
  username?: string;
  allowedMentions?: AllowedMentions;
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
        username: args.username ?? "batch0",
        allowed_mentions: args.allowedMentions ?? { parse: [] },
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
// staff can re-target them without redeploying. React-cached per request:
// a single Discord-touching flow reads these several times (enabled gate,
// channel routing, role map) and should pay for the query once. Nothing is
// cached across requests, so edits still apply immediately.
// ---------------------------------------------------------------------------
export type DiscordSettings = {
  enabled: boolean;
  announcementsChannelId: string;
  eventsChannelId: string;
  adminFeedChannelId: string;
  // Added in 0033 to support the feature pack: auto-team channels live
  // under teamsCategoryId, milestone check-ins go to winsChannelId,
  // mentor-on-call status pins under helpChannelId, the OH queue
  // routes callers into ohVoiceChannelId, onboarding pings reference
  // introductionsChannelId, and the persistent "Mentors on now" pin
  // is tracked by oncallMessageId.
  teamsCategoryId: string;
  winsChannelId: string;
  helpChannelId: string;
  ohVoiceChannelId: string;
  introductionsChannelId: string;
  oncallMessageId: string;
  roleIdByRole: Partial<Record<Role, string>>;

  // Founder pass role, granted to holders of a redeemed 3D-printed card.
  //
  // A SIBLING of roleIdByRole, never a member of it, and the distinction is
  // load-bearing: syncMemberRoles() treats every value in roleIdByRole as
  // batch0-managed and strips any that isn't the member's current target
  // role. Filing the founder role in there would tear it off every holder on
  // the next sync — a Stripe webhook, an application accept, an admin
  // resync-all, or anyone running /sync in Discord. It is also orthogonal by
  // nature: a pass holder is a student OR mentor OR investor *and* a pass
  // holder, whereas roleIdByRole is a one-of-N mapping keyed by Role.
  founderPassRoleId: string;
};

const SETTING_KEYS = [
  "discord_enabled",
  "discord_channel_announcements_id",
  "discord_channel_events_id",
  "discord_channel_admin_feed_id",
  "discord_channel_teams_category_id",
  "discord_channel_wins_id",
  "discord_channel_help_id",
  "discord_channel_oh_voice_id",
  "discord_channel_introductions_id",
  "discord_oncall_message_id",
  "discord_role_student_id",
  "discord_role_mentor_id",
  "discord_role_admin_id",
  "discord_role_investor_id",
  "discord_role_founder_pass_id",
] as const;

export const getDiscordSettings = cache(async (): Promise<DiscordSettings> => {
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
    teamsCategoryId: str("discord_channel_teams_category_id"),
    winsChannelId: str("discord_channel_wins_id"),
    helpChannelId: str("discord_channel_help_id"),
    ohVoiceChannelId: str("discord_channel_oh_voice_id"),
    introductionsChannelId: str("discord_channel_introductions_id"),
    oncallMessageId: str("discord_oncall_message_id"),
    roleIdByRole: {
      student: str("discord_role_student_id") || env.discordRoleStudent || "",
      mentor: str("discord_role_mentor_id"),
      admin: str("discord_role_admin_id"),
      investor: str("discord_role_investor_id"),
    },
    founderPassRoleId: str("discord_role_founder_pass_id"),
  };
});

/**
 * Persist a single site_settings key (used after we create new
 * channels / pin messages from code so the IDs stick across calls).
 * Best-effort — failures are logged, not thrown, because losing the
 * write just degrades to the manual config form, not a hard outage.
 */
export async function saveDiscordSetting(
  key: string,
  value: string,
): Promise<void> {
  try {
    const admin = createAdminClient();
    // supabase-js JSON-encodes the value before it hits jsonb, so a plain
    // string round-trips as a JSON string ("foo") — matches the existing
    // settings-form convention.
    await admin
      .from("site_settings")
      .upsert(
        { key, value, updated_at: new Date().toISOString() } as any,
        { onConflict: "key" },
      );
  } catch (err) {
    console.error("[discord] saveDiscordSetting failed", key, err);
  }
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
    return (await res.json()) as {
      roles: string[];
      nick: string | null;
      user?: { id: string; username: string; global_name: string | null; avatar: string | null };
    };
  } catch {
    return null;
  }
}

export async function fetchGuildMemberCount(): Promise<number | null> {
  if (!(await isDiscordEnabled())) return null;
  if (!env.discordBotToken || !env.discordGuildId) return null;
  try {
    // `?with_counts=true` returns approximate_member_count without
    // paginating /guilds/:id/members. Cheap enough to do on each admin
    // page load.
    const res = await fetch(
      `${API}/guilds/${env.discordGuildId}?with_counts=true`,
      { headers: { Authorization: `Bot ${env.discordBotToken}` } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { approximate_member_count?: number };
    return typeof json.approximate_member_count === "number"
      ? json.approximate_member_count
      : null;
  } catch {
    return null;
  }
}

/**
 * The OAuth2 redirect URIs registered on the Discord application.
 *
 * Exists because "Invalid OAuth2 redirect_uri" is a dead end for whoever hits
 * it: Discord rejects on its own domain, before the browser ever comes back,
 * so /auth/discord/callback never runs and nothing on our side can catch or
 * explain it. The only place it can be caught is the admin side, ahead of time.
 *
 * Null when the list can't be read — the caller degrades to printing the URIs
 * that need registering, which is still the actionable half.
 */
export type DiscordAppInfo = {
  /** The application the BOT TOKEN belongs to. */
  id: string | null;
  name: string | null;
  redirectUris: string[] | null;
};

export async function fetchDiscordAppInfo(): Promise<DiscordAppInfo | null> {
  if (!env.discordBotToken) return null;
  try {
    const res = await fetch(`${API}/applications/@me`, {
      headers: { Authorization: `Bot ${env.discordBotToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      id?: unknown;
      name?: unknown;
      redirect_uris?: unknown;
    };
    return {
      id: typeof json.id === "string" ? json.id : null,
      name: typeof json.name === "string" ? json.name : null,
      redirectUris: Array.isArray(json.redirect_uris)
        ? json.redirect_uris.filter((u): u is string => typeof u === "string")
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * Every redirect URI the app can legitimately send. /auth/discord/start
 * derives it from the REQUEST origin, so a visitor on www produces a different
 * URI than one on the apex — both must be registered or linking dies for half
 * the users.
 */
export function expectedOauthRedirectUris(siteUrl: string): string[] {
  const out = new Set<string>();
  try {
    const url = new URL(siteUrl);
    const apex = url.host.replace(/^www\./, "");
    for (const host of [apex, `www.${apex}`]) {
      out.add(`${url.protocol}//${host}/auth/discord/callback`);
    }
  } catch {
    /* a malformed NEXT_PUBLIC_SITE_URL shouldn't take the doctor down */
  }
  return [...out];
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
 * Grant the founder pass role to a linked member.
 *
 * Needs only the bot token and profiles.discord_user_id, so it works for
 * someone who linked Discord months ago — no re-link, no OAuth token. (The
 * stored OAuth token is revoked right after linking anyway; only
 * addMemberToGuild's guilds.join needs one, and that is for pulling a
 * non-member into the server.)
 *
 * Returns false when Discord is off, unconfigured, the role ID is unset, or
 * the member simply hasn't linked. All of those are ordinary states, not
 * errors: the pass is still redeemed and every other perk still applies. The
 * caller should never fail a redemption because Discord was unreachable.
 */
export async function grantFounderPassRole(
  discordUserId: string | null | undefined,
): Promise<boolean> {
  if (!discordUserId) return false;
  const settings = await getDiscordSettings();
  if (!settings.enabled || !settings.founderPassRoleId) return false;
  return addRoleToMember(discordUserId, settings.founderPassRoleId);
}

/**
 * Make a member's Discord roles match the user's batch0 role.
 * Adds the role mapped to their current batch0 role, removes any
 * other batch0-managed roles they had. Safe to call repeatedly.
 *
 * NOTE the blast radius of `managedRoleIds` below: every value in
 * roleIdByRole is treated as ours to remove. Any role that is NOT a
 * one-of-N mapping of a batch0 Role must stay out of that map or it gets
 * stripped here on the next sync. The founder pass role is the live example —
 * it is a sibling field (settings.founderPassRoleId) for exactly this reason.
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
    components?: Record<string, any>[];
    allowedMentions?: AllowedMentions;
  },
): Promise<boolean> {
  const id = await postChannelMessageWithId(channelId, payload);
  return id != null;
}

/**
 * Same as `postChannelMessage` but returns the new message id (or null
 * on failure) — used when the caller needs to open a thread on the
 * posted message or edit it later.
 */
export async function postChannelMessageWithId(
  channelId: string,
  payload: {
    content?: string;
    embeds?: Record<string, any>[];
    components?: Record<string, any>[];
    allowedMentions?: AllowedMentions;
  },
): Promise<string | null> {
  if (!(await isDiscordEnabled())) return null;
  if (!env.discordBotToken || !channelId) return null;
  try {
    const { allowedMentions, ...rest } = payload;
    const res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...rest,
        allowed_mentions: allowedMentions ?? { parse: [] },
      }),
    });
    if (!res.ok) {
      console.error("[discord] channel post failed", res.status, await res.text());
      return null;
    }
    try {
      const json = (await res.json()) as { id?: string };
      return json.id ?? null;
    } catch {
      return null;
    }
  } catch (err) {
    console.error("[discord] channel post error", err);
    return null;
  }
}

const BRAND_COLOR = 0xffbb00; // tailwind yellow-400, matches the phosphor token

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
        ? `batch0 · ${args.cohortName}`
        : "batch0",
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Open a DM channel with a guild member and post a message into it.
 * Best-effort: Discord refuses DMs if the user has them disabled, which
 * we treat as a soft fail.
 */
export async function sendDirectMessage(
  discordUserId: string,
  payload: { content?: string; embeds?: Record<string, any>[] },
): Promise<boolean> {
  if (!(await isDiscordEnabled())) return false;
  if (!env.discordBotToken || !discordUserId) return false;
  try {
    const openRes = await fetch(`${API}/users/@me/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: discordUserId }),
    });
    if (!openRes.ok) {
      console.error("[discord] open DM failed", openRes.status);
      return false;
    }
    const channel = (await openRes.json()) as { id?: string };
    if (!channel.id) return false;
    return await postChannelMessage(channel.id, payload);
  } catch (err) {
    console.error("[discord] DM failed", err);
    return false;
  }
}

export function applicationEmbed(args: {
  name: string;
  email: string | null;
  cohortName: string | null;
  link: string;
}) {
  const lines: string[] = [];
  if (args.email) lines.push(`📧 ${args.email}`);
  if (args.cohortName) lines.push(`👥 ${args.cohortName}`);
  return {
    title: `📥 New application — ${args.name}`,
    description: lines.join("\n") || undefined,
    color: BRAND_COLOR,
    url: args.link,
    footer: { text: "batch0 · applications" },
    timestamp: new Date().toISOString(),
  };
}

export function refundEmbed(args: {
  name: string | null;
  amountCents: number;
  description: string;
  reason: string | null;
  kind: "fee" | "fine" | "payment";
}) {
  const dollars = (args.amountCents / 100).toFixed(2);
  const lines: string[] = [`💸 $${dollars} refunded`];
  if (args.description) lines.push(`📝 ${args.description}`);
  if (args.reason) lines.push(`🗒️ ${args.reason}`);
  return {
    title: `↩️ Refund — ${args.name ?? "user"}`,
    description: lines.join("\n"),
    color: BRAND_COLOR,
    footer: { text: `batch0 · ${args.kind}` },
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
      text: args.cohortName ? `batch0 · ${args.cohortName}` : "batch0",
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

// ---------------------------------------------------------------------------
// Message editing / pinning — used by the on-call pinned-message updater.
// ---------------------------------------------------------------------------
export async function editChannelMessage(
  channelId: string,
  messageId: string,
  payload: {
    content?: string | null;
    embeds?: Record<string, any>[];
    allowedMentions?: AllowedMentions;
  },
): Promise<boolean> {
  if (!(await isDiscordEnabled())) return false;
  if (!env.discordBotToken || !channelId || !messageId) return false;
  try {
    const { allowedMentions, ...rest } = payload;
    const res = await fetch(
      `${API}/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${env.discordBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...rest,
          allowed_mentions: allowedMentions ?? { parse: [] },
        }),
      },
    );
    if (!res.ok) {
      console.error("[discord] edit message failed", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[discord] edit message error", err);
    return false;
  }
}

/**
 * Post a new message AND pin it. Returns the message id so the caller
 * can edit it later without re-posting. Pin permission requires
 * `MANAGE_MESSAGES` in the target channel.
 */
export async function postAndPinMessage(
  channelId: string,
  payload: {
    content?: string;
    embeds?: Record<string, any>[];
    allowedMentions?: AllowedMentions;
  },
): Promise<string | null> {
  if (!(await isDiscordEnabled())) return null;
  if (!env.discordBotToken || !channelId) return null;
  try {
    const { allowedMentions, ...rest } = payload;
    const res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...rest,
        allowed_mentions: allowedMentions ?? { parse: [] },
      }),
    });
    if (!res.ok) {
      console.error("[discord] post for pin failed", res.status);
      return null;
    }
    const msg = (await res.json()) as { id?: string };
    if (!msg.id) return null;
    // Pin — non-fatal if it errors (we'll still return the id).
    await fetch(`${API}/channels/${channelId}/pins/${msg.id}`, {
      method: "PUT",
      headers: { Authorization: `Bot ${env.discordBotToken}` },
    }).catch(() => {});
    return msg.id;
  } catch (err) {
    console.error("[discord] post-and-pin error", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Thread + channel management. Used to spawn per-team channels and Demo
// Day pitch threads on the fly.
// ---------------------------------------------------------------------------

/** Open a public thread on an existing message. */
export async function startThreadFromMessage(args: {
  channelId: string;
  messageId: string;
  name: string;
  autoArchiveMinutes?: number;
}): Promise<string | null> {
  if (!(await isDiscordEnabled())) return null;
  if (!env.discordBotToken || !args.channelId || !args.messageId) return null;
  try {
    const res = await fetch(
      `${API}/channels/${args.channelId}/messages/${args.messageId}/threads`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${env.discordBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: args.name.slice(0, 100),
          auto_archive_duration: args.autoArchiveMinutes ?? 1440, // 1 day
        }),
      },
    );
    if (!res.ok) {
      console.error("[discord] start thread failed", res.status, await res.text());
      return null;
    }
    const t = (await res.json()) as { id?: string };
    return t.id ?? null;
  } catch (err) {
    console.error("[discord] start thread error", err);
    return null;
  }
}

/**
 * Delete a channel (works for text, voice, or thread channels). Returns
 * true on success or "already gone".
 */
export async function deleteChannel(channelId: string): Promise<boolean> {
  if (!env.discordBotToken || !channelId) return false;
  try {
    const res = await fetch(`${API}/channels/${channelId}`, {
      method: "DELETE",
      headers: { Authorization: `Bot ${env.discordBotToken}` },
    });
    return res.ok || res.status === 204 || res.status === 404;
  } catch (err) {
    console.error("[discord] delete channel error", err);
    return false;
  }
}

/**
 * Edit a channel's permission overwrites. Used when team membership
 * changes — we re-issue the full overwrite set scoped to current
 * members + the assigned mentor + admin role.
 */
export async function setChannelPermissionOverwrites(
  channelId: string,
  overwrites: { id: string; type: 0 | 1; allow: string; deny: string }[],
): Promise<boolean> {
  if (!env.discordBotToken || !channelId) return false;
  try {
    const res = await fetch(`${API}/channels/${channelId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${env.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permission_overwrites: overwrites }),
    });
    return res.ok;
  } catch (err) {
    console.error("[discord] patch channel overwrites error", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Team channel provisioning. Hidden-from-everyone text + voice channels
// under the configured teams category, viewable only by the team's
// members + mentor + admin role. Idempotent so re-running on a team
// that already has channels just re-syncs the overwrites.
// ---------------------------------------------------------------------------
const PERM_VIEW = BigInt(1) << BigInt(10);
const PERM_SEND = BigInt(1) << BigInt(11);
const PERM_CONNECT_BIT = BigInt(1) << BigInt(20);
const PERM_SPEAK_BIT = BigInt(1) << BigInt(21);

function teamOverwrites(args: {
  guildEveryoneId: string;
  memberDiscordIds: string[];
  mentorDiscordIds: string[];
  adminRoleId: string | null;
  includeVoice: boolean;
}): { id: string; type: 0 | 1; allow: string; deny: string }[] {
  const baseAllow = args.includeVoice
    ? (PERM_VIEW | PERM_SEND | PERM_CONNECT_BIT | PERM_SPEAK_BIT).toString()
    : (PERM_VIEW | PERM_SEND).toString();
  const ows: { id: string; type: 0 | 1; allow: string; deny: string }[] = [
    {
      // Hide from @everyone
      id: args.guildEveryoneId,
      type: 0,
      allow: "0",
      deny: PERM_VIEW.toString(),
    },
  ];
  for (const uid of args.memberDiscordIds) {
    if (!uid) continue;
    ows.push({ id: uid, type: 1, allow: baseAllow, deny: "0" });
  }
  for (const uid of args.mentorDiscordIds) {
    if (!uid) continue;
    ows.push({ id: uid, type: 1, allow: baseAllow, deny: "0" });
  }
  if (args.adminRoleId) {
    ows.push({ id: args.adminRoleId, type: 0, allow: baseAllow, deny: "0" });
  }
  return ows;
}

export type ProvisionTeamChannelsArgs = {
  teamName: string;
  teamSlug: string;
  parentId: string;
  memberDiscordIds: string[];
  mentorDiscordIds: string[];
  adminRoleId: string | null;
};

export type ProvisionedTeamChannels = {
  textChannelId: string | null;
  voiceChannelId: string | null;
};

/**
 * Create the per-team text + voice channels under the configured
 * teams category. Returns the new channel IDs so the caller persists
 * them on `teams.discord_text_channel_id` / `..._voice_channel_id`.
 */
export async function provisionTeamChannels(
  args: ProvisionTeamChannelsArgs,
): Promise<ProvisionedTeamChannels> {
  if (!(await isDiscordEnabled())) {
    return { textChannelId: null, voiceChannelId: null };
  }
  if (!env.discordBotToken || !env.discordGuildId || !args.parentId) {
    return { textChannelId: null, voiceChannelId: null };
  }
  const guildEveryoneId = env.discordGuildId;
  const safeName = args.teamSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "team";

  const baseText = `team-${safeName}`;
  const baseVoice = `${args.teamName.slice(0, 80)} voice`;

  let textId: string | null = null;
  let voiceId: string | null = null;

  // Text channel
  try {
    const textRes = await fetch(`${API}/guilds/${env.discordGuildId}/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: baseText,
        type: 0,
        parent_id: args.parentId,
        topic: `Private team channel for ${args.teamName}`,
        permission_overwrites: teamOverwrites({
          guildEveryoneId,
          memberDiscordIds: args.memberDiscordIds,
          mentorDiscordIds: args.mentorDiscordIds,
          adminRoleId: args.adminRoleId,
          includeVoice: false,
        }),
      }),
    });
    if (textRes.ok) {
      const t = (await textRes.json()) as { id?: string };
      textId = t.id ?? null;
    } else {
      console.error("[discord] team text create failed", textRes.status, await textRes.text());
    }
  } catch (err) {
    console.error("[discord] team text create error", err);
  }

  // Voice channel
  try {
    const voiceRes = await fetch(`${API}/guilds/${env.discordGuildId}/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: baseVoice,
        type: 2,
        parent_id: args.parentId,
        permission_overwrites: teamOverwrites({
          guildEveryoneId,
          memberDiscordIds: args.memberDiscordIds,
          mentorDiscordIds: args.mentorDiscordIds,
          adminRoleId: args.adminRoleId,
          includeVoice: true,
        }),
      }),
    });
    if (voiceRes.ok) {
      const v = (await voiceRes.json()) as { id?: string };
      voiceId = v.id ?? null;
    } else {
      console.error("[discord] team voice create failed", voiceRes.status, await voiceRes.text());
    }
  } catch (err) {
    console.error("[discord] team voice create error", err);
  }

  return { textChannelId: textId, voiceChannelId: voiceId };
}

/**
 * Re-issue the overwrites for an already-provisioned team channel so it
 * reflects the current member list. Skip silently when the channel ID
 * is missing.
 */
export async function syncTeamChannelOverwrites(args: {
  channelId: string | null;
  isVoice: boolean;
  memberDiscordIds: string[];
  mentorDiscordIds: string[];
  adminRoleId: string | null;
}): Promise<boolean> {
  if (!args.channelId) return false;
  if (!env.discordGuildId) return false;
  return await setChannelPermissionOverwrites(
    args.channelId,
    teamOverwrites({
      guildEveryoneId: env.discordGuildId,
      memberDiscordIds: args.memberDiscordIds,
      mentorDiscordIds: args.mentorDiscordIds,
      adminRoleId: args.adminRoleId,
      includeVoice: args.isVoice,
    }),
  );
}

// ---------------------------------------------------------------------------
// Interaction response helpers (modals, buttons, ephemeral acks, etc.).
// Building blocks the handler composes — keeps the handler readable.
// ---------------------------------------------------------------------------
export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
} as const;

export const MessageFlag = {
  EPHEMERAL: 1 << 6,
} as const;

/**
 * Build a "Show modal" response payload. The handler returns this from
 * the slash command POST; Discord opens the dialog client-side. We use
 * this for `/checkin` so the student can type a multi-line response
 * without flooding the channel.
 */
export function modalResponse(args: {
  customId: string;
  title: string;
  components: { customId: string; label: string; placeholder?: string; required?: boolean; style?: 1 | 2; maxLength?: number; value?: string }[];
}) {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: args.customId,
      title: args.title.slice(0, 45),
      components: args.components.map((c) => ({
        type: 1, // ACTION_ROW
        components: [
          {
            type: 4, // TEXT_INPUT
            custom_id: c.customId,
            label: c.label.slice(0, 45),
            style: c.style ?? 2, // 1 = short, 2 = paragraph
            placeholder: c.placeholder?.slice(0, 100),
            required: c.required ?? false,
            max_length: c.maxLength ?? 4000,
            value: c.value,
          },
        ],
      })),
    },
  };
}

/**
 * Helper that builds a row of buttons. Each button's `custom_id` flows
 * back to the interactions handler when clicked; we encode the action +
 * any IDs (e.g. `rsvp:going:<eventId>`) so the handler can route
 * without consulting Discord again.
 */
export function buttonRow(
  buttons: { customId: string; label: string; style?: 1 | 2 | 3 | 4; emoji?: string }[],
) {
  return {
    type: 1,
    components: buttons.slice(0, 5).map((b) => ({
      type: 2, // BUTTON
      style: b.style ?? 2, // 1 primary, 2 secondary, 3 success, 4 danger
      label: b.label.slice(0, 80),
      custom_id: b.customId.slice(0, 100),
      emoji: b.emoji ? { name: b.emoji } : undefined,
    })),
  };
}

// ---------------------------------------------------------------------------
// Followups (REST). Slash command handlers reply within 3s; for slower
// work (DB writes etc.) the standard pattern is to defer the response,
// then POST the real reply to the followup endpoint.
// ---------------------------------------------------------------------------
export async function sendInteractionFollowup(args: {
  applicationId: string;
  interactionToken: string;
  content?: string;
  embeds?: Record<string, any>[];
  components?: Record<string, any>[];
  ephemeral?: boolean;
}): Promise<boolean> {
  try {
    const res = await fetch(
      `${API}/webhooks/${args.applicationId}/${args.interactionToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: args.content,
          embeds: args.embeds,
          components: args.components,
          allowed_mentions: { parse: [] },
          flags: args.ephemeral ? MessageFlag.EPHEMERAL : 0,
        }),
      },
    );
    if (!res.ok) {
      console.error("[discord] followup failed", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[discord] followup error", err);
    return false;
  }
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

// ---------------------------------------------------------------------------
// Slash-command registration. We register globally — propagation is up to
// an hour on a fresh app, instant after the first registration. The spec
// is mirrored by the /api/discord/interactions handler.
// ---------------------------------------------------------------------------
// Application command option types (subset).
//   3 = STRING, 6 = USER. See:
//   https://discord.com/developers/docs/interactions/application-commands
// Discord command "type" enum.
//   1 = CHAT_INPUT (default — a slash command),
//   2 = USER context menu, 3 = MESSAGE context menu.
// We use type 3 for the "Flag as Blocker" message-context entry.
export const SLASH_COMMANDS = [
  {
    name: "me",
    description: "Show your batch0 status (private).",
  },
  {
    name: "link",
    description: "DM yourself the account-link URL.",
  },
  {
    name: "cohort",
    description: "Show your current cohort.",
  },
  {
    name: "events",
    description: "Show the next few upcoming batch0 events.",
  },
  {
    name: "sync",
    description: "Re-sync your Discord roles with your batch0 status.",
  },
  {
    name: "help",
    description: "List every batch0 slash command.",
  },
  {
    name: "whois",
    description: "Admins only — look up a Discord user's batch0 profile.",
    options: [
      {
        name: "user",
        description: "The Discord user to look up.",
        type: 6,
        required: true,
      },
    ],
  },
  {
    name: "announce",
    description: "Admins only — broadcast to enrolled students.",
    options: [
      { name: "title", description: "Announcement title.", type: 3, required: true },
      { name: "message", description: "Body of the announcement.", type: 3, required: true },
    ],
  },
  // --- 0033 feature pack ---------------------------------------------------
  {
    name: "checkin",
    description: "Post this week's check-in without leaving Discord.",
  },
  {
    name: "team",
    description: "Show your team's quick stats: members, mentor, next event.",
  },
  {
    name: "ask",
    description: "Ask the batch0 AI co-founder a question.",
    options: [
      {
        name: "question",
        description: "What do you want to ask?",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "start",
    description: "(Re)run the 3-step onboarding wizard via DM.",
  },
  {
    name: "queue",
    description: "Office-hours queue: join, leave, or claim the next caller.",
    options: [
      {
        name: "join",
        description: "Add yourself to the office-hours queue.",
        type: 1, // SUB_COMMAND
        options: [
          {
            name: "topic",
            description: "What do you need help with? (optional)",
            type: 3,
            required: false,
          },
        ],
      },
      {
        name: "leave",
        description: "Remove yourself from the office-hours queue.",
        type: 1,
      },
      {
        name: "list",
        description: "Show who's currently in the queue.",
        type: 1,
      },
      {
        name: "next",
        description: "Mentors only — claim the next person in the queue.",
        type: 1,
      },
    ],
  },
  {
    name: "oncall",
    description: "Mentors only — flip your office-hours availability.",
    options: [
      {
        name: "on",
        description: "Mark yourself available.",
        type: 1,
        options: [
          {
            name: "note",
            description: "Optional note (e.g. \"in #help for 60min\").",
            type: 3,
            required: false,
          },
          {
            name: "minutes",
            description: "Auto-clear after N minutes (default 60).",
            type: 4, // INTEGER
            required: false,
          },
        ],
      },
      {
        name: "off",
        description: "Mark yourself unavailable.",
        type: 1,
      },
      {
        name: "list",
        description: "Show who's currently on-call.",
        type: 1,
      },
    ],
  },
  // Message context menu — appears under right-click → Apps on any
  // message. The handler creates a team_blockers row and opens a thread.
  {
    type: 3,
    name: "🆘 Flag as Blocker",
  },
] as const;

/**
 * Register (or overwrite) every global slash command for the
 * application. PUT replaces the full set in one request, so removing a
 * command from SLASH_COMMANDS unregisters it on the next call.
 *
 * Returns the registered command summaries from Discord so the UI can
 * confirm what's actually live.
 */
export async function registerSlashCommands(): Promise<
  { id: string; name: string }[]
> {
  if (!env.discordBotToken || !env.discordClientId) {
    throw new Error(
      "Need DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID to register commands.",
    );
  }
  const res = await fetch(
    `${API}/applications/${env.discordClientId}/commands`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${env.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(SLASH_COMMANDS),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord rejected commands: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { id: string; name: string }[];
  return data.map((c) => ({ id: c.id, name: c.name }));
}

/**
 * GET the currently-registered global commands. Used to render the
 * "what's live in Discord right now" indicator on /admin/discord.
 */
export async function listRegisteredCommands(): Promise<
  { id: string; name: string }[] | null
> {
  if (!env.discordBotToken || !env.discordClientId) return null;
  try {
    const res = await fetch(
      `${API}/applications/${env.discordClientId}/commands`,
      { headers: { Authorization: `Bot ${env.discordBotToken}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { id: string; name: string }[];
    return data.map((c) => ({ id: c.id, name: c.name }));
  } catch {
    return null;
  }
}

/**
 * Point the Discord application's Interactions Endpoint URL at this
 * deployment.
 *
 * Registering commands is only half of making slash commands work: the
 * command list lives on the application, but Discord delivers the actual
 * interaction to whatever URL the application has stored. Those two are
 * set in completely different places, so a domain change (batch0 was
 * sparklineyouth.org) leaves the commands looking perfectly registered on
 * /admin/discord while every invocation is POSTed to the old host and the
 * user just sees "The application did not respond." Nothing in the app
 * could fix that from here — it was a manual trip to the developer
 * portal, which is precisely the kind of step that silently never happens.
 *
 * Discord validates the URL synchronously by sending it a signed PING and
 * refuses the PATCH unless it gets a valid PONG back, so a 400 here
 * almost always means DISCORD_PUBLIC_KEY doesn't match this application
 * rather than that the URL is malformed.
 */
export async function setInteractionsEndpoint(
  url?: string,
): Promise<{ url: string }> {
  if (!env.discordBotToken) {
    throw new Error("Need DISCORD_BOT_TOKEN to update the application.");
  }
  const target = url ?? `${env.siteUrl}/api/discord/interactions`;
  const res = await fetch(`${API}/applications/@me`, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${env.discordBotToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ interactions_endpoint_url: target }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 400);
    throw new Error(
      `Discord rejected the interactions endpoint (${res.status}). ` +
        `It sends a signed PING to ${target} and only saves the URL if it ` +
        `verifies — check that DISCORD_PUBLIC_KEY matches this application ` +
        `and that the deployment is live. ${text}`,
    );
  }
  return { url: target };
}

// ---------------------------------------------------------------------------
// Server bootstrap: wipe + rebuild a guild's roles and channels to the
// canonical batch0 layout. Designed for the very first setup so
// staff don't have to hand-craft 15 channels + 4 roles + permission
// overwrites in the Discord UI. Destructive — call site must confirm.
// ---------------------------------------------------------------------------

// Permission bit shifts we care about. BigInt because Discord permission
// fields are 64-bit and serialized as decimal strings.
const PERM_VIEW_CHANNEL = BigInt(1) << BigInt(10);
const PERM_SEND_MESSAGES = BigInt(1) << BigInt(11);
const PERM_CONNECT = BigInt(1) << BigInt(20);
const PERM_SPEAK = BigInt(1) << BigInt(21);

const CHANNEL_TYPE_TEXT = 0;
const CHANNEL_TYPE_VOICE = 2;
const CHANNEL_TYPE_CATEGORY = 4;

// Polite throttle to stay well under Discord's per-route rate limits when
// we're firing a long series of delete/create requests in a row.
async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type DiscordChannel = {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
};
type DiscordRole = {
  id: string;
  name: string;
  managed: boolean;
  position: number;
};

async function botFetch(
  path: string,
  init: RequestInit & { json?: unknown } = {},
) {
  if (!env.discordBotToken) throw new Error("DISCORD_BOT_TOKEN not set");
  const { json, headers, ...rest } = init;
  return fetch(`${API}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bot ${env.discordBotToken}`,
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : (init.body as any),
  });
}

async function listGuildChannels(): Promise<DiscordChannel[]> {
  const res = await botFetch(`/guilds/${env.discordGuildId}/channels`);
  if (!res.ok) throw new Error(`list channels failed: ${res.status}`);
  return (await res.json()) as DiscordChannel[];
}

async function listGuildRoles(): Promise<DiscordRole[]> {
  const res = await botFetch(`/guilds/${env.discordGuildId}/roles`);
  if (!res.ok) throw new Error(`list roles failed: ${res.status}`);
  return (await res.json()) as DiscordRole[];
}

async function deleteRole(roleId: string): Promise<boolean> {
  const res = await botFetch(
    `/guilds/${env.discordGuildId}/roles/${roleId}`,
    { method: "DELETE" },
  );
  return res.ok || res.status === 204;
}

async function createRole(args: {
  name: string;
  color: number;
  hoist?: boolean;
  permissions?: bigint;
  mentionable?: boolean;
}): Promise<DiscordRole> {
  const res = await botFetch(`/guilds/${env.discordGuildId}/roles`, {
    method: "POST",
    json: {
      name: args.name,
      color: args.color,
      hoist: args.hoist ?? true,
      mentionable: args.mentionable ?? true,
      permissions: (args.permissions ?? BigInt(0)).toString(),
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`create role "${args.name}" failed: ${res.status} ${t}`);
  }
  return (await res.json()) as DiscordRole;
}

type PermissionOverwrite = {
  id: string;
  type: 0 | 1; // 0 = role, 1 = member
  allow: string;
  deny: string;
};

async function createChannel(args: {
  name: string;
  type: number;
  parent_id?: string;
  topic?: string;
  permission_overwrites?: PermissionOverwrite[];
}): Promise<DiscordChannel> {
  const res = await botFetch(`/guilds/${env.discordGuildId}/channels`, {
    method: "POST",
    json: args,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`create channel "${args.name}" failed: ${res.status} ${t}`);
  }
  return (await res.json()) as DiscordChannel;
}

async function patchGuild(json: Record<string, unknown>): Promise<void> {
  // Best-effort. The guild PATCH can fail for community-server-only
  // fields on a non-community guild; we don't want that to abort the
  // bootstrap.
  try {
    await botFetch(`/guilds/${env.discordGuildId}`, {
      method: "PATCH",
      json,
    });
  } catch (err) {
    console.error("[discord] patch guild failed", err);
  }
}

export type CanonicalLayoutIds = {
  announcementsChannelId: string;
  eventsChannelId: string;
  adminFeedChannelId: string;
  // Feature-pack channel IDs returned so the caller can upsert them
  // alongside the originals.
  teamsCategoryId: string;
  winsChannelId: string;
  helpChannelId: string;
  ohVoiceChannelId: string;
  introductionsChannelId: string;
  roleStudentId: string;
  roleMentorId: string;
  roleAdminId: string;
  roleInvestorId: string;
  // A SIBLING of the four role-mapped roles, never one of them — see the
  // long note on DiscordSettings.founderPassRoleId. It is built here for a
  // blunt reason: a rebuilt server used to leave
  // discord_role_founder_pass_id pointing at a role that no longer
  // existed, so every redemption silently failed to grant the perk and
  // the doctor flagged it forever with no way to fix it short of hand-
  // crafting the role in Discord.
  roleFounderPassId: string;
};

export type LayoutSyncResult = {
  rolesCreated: { name: string; id: string }[];
  rolesReused: { name: string; id: string }[];
  channelsCreated: { name: string; id: string }[];
  channelsReused: { name: string; id: string }[];
  ids: CanonicalLayoutIds;
};

export type BootstrapResult = LayoutSyncResult & {
  channelsDeleted: number;
  rolesDeleted: number;
};

/** What `repairGuildLayout` gives back — same shape, nothing deleted. */
export type RepairResult = LayoutSyncResult;

/**
 * Build the canonical batch0 layout — 5 roles, 6 categories, ~14
 * channels — and return the IDs the rest of the integration keys off.
 *
 * `reuseExisting` picks between the two very different jobs this serves:
 *
 *   false — called straight after a wipe, when there is nothing left to
 *           match against. Every role and channel is created fresh.
 *   true  — the repair path. Anything already in the guild under the
 *           canonical name is adopted as-is and reported under
 *           `rolesReused` / `channelsReused`; only what is genuinely
 *           missing gets created. Permission overwrites are applied ONLY
 *           to channels we create, so a repair never stomps permissions
 *           staff tuned by hand in Discord.
 *
 * Throttled at ~3 ops/sec to stay clear of Discord's rate limits.
 */
async function ensureCanonicalLayout(
  reuseExisting: boolean,
): Promise<LayoutSyncResult> {
  const guildId = env.discordGuildId!;
  const everyoneId = guildId; // @everyone always shares the guild's ID

  const existingRoles = reuseExisting ? await listGuildRoles() : [];
  const existingChannels = reuseExisting ? await listGuildChannels() : [];

  const rolesCreated: { name: string; id: string }[] = [];
  const rolesReused: { name: string; id: string }[] = [];
  const channelsCreated: { name: string; id: string }[] = [];
  const channelsReused: { name: string; id: string }[] = [];

  const norm = (s: string) => s.trim().toLowerCase();

  const ensureRole = async (args: {
    name: string;
    color: number;
  }): Promise<DiscordRole> => {
    const hit = existingRoles.find(
      (r) => !r.managed && r.id !== guildId && norm(r.name) === norm(args.name),
    );
    if (hit) {
      rolesReused.push({ name: hit.name, id: hit.id });
      return hit;
    }
    const role = await createRole(args);
    rolesCreated.push({ name: role.name, id: role.id });
    await sleep(350);
    return role;
  };

  // Channels match on name + type, and on parent when the caller knows
  // it. The comparison is case-insensitive because Discord lower-cases
  // and dash-joins text channel names on create, so what comes back does
  // not always equal what went in.
  const ensureChannel = async (
    args: Parameters<typeof createChannel>[0],
  ): Promise<DiscordChannel> => {
    const hit = existingChannels.find(
      (c) =>
        c.type === args.type &&
        norm(c.name) === norm(args.name) &&
        (args.parent_id === undefined ||
          (c.parent_id ?? null) === args.parent_id),
    );
    if (hit) {
      channelsReused.push({ name: hit.name, id: hit.id });
      return hit;
    }
    const ch = await createChannel(args);
    channelsCreated.push({ name: ch.name, id: ch.id });
    await sleep(350);
    return ch;
  };

  // ── Roles ──────────────────────────────────────────────────────────
  // Discord drops new roles at the bottom of the hierarchy, just above
  // @everyone, so the bot's own managed role stays above them and can
  // assign them.
  //
  // Note: we intentionally do NOT grant ADMINISTRATOR to the Admin role.
  // Discord refuses to let a bot create a role with permissions the bot
  // itself lacks, so requesting it aborts the whole run with
  // `Missing Permissions (50013)`. The Admin role is a marker for "this
  // user is staff" — the integration matches on role ID, not on Discord
  // permission bits. Server owners can hand-grant Manage Server in
  // Discord's Roles UI afterward if they want to.
  const studentRole = await ensureRole({ name: "Student", color: 0x3b82f6 });
  const mentorRole = await ensureRole({ name: "Mentor", color: 0x8b5cf6 });
  const investorRole = await ensureRole({ name: "Investor", color: 0xf59e0b });
  const adminRole = await ensureRole({ name: "Admin", color: 0xef4444 });
  const founderPassRole = await ensureRole({
    name: "Founder Pass",
    color: BRAND_COLOR,
  });

  // Helper to build a "hide from everyone, show only to these roles"
  // overwrite array.
  const hideExceptFor = (
    allowedRoleIds: string[],
    extraAllow: bigint = BigInt(0),
  ): PermissionOverwrite[] => [
    {
      id: everyoneId,
      type: 0,
      allow: "0",
      deny: PERM_VIEW_CHANNEL.toString(),
    },
    ...allowedRoleIds.map((id) => ({
      id,
      type: 0 as const,
      allow: (PERM_VIEW_CHANNEL | extraAllow).toString(),
      deny: "0",
    })),
  ];

  // "Staff can post, everyone else reads" — the shape shared by
  // #welcome, #rules, #announcements, #wins and #events.
  const staffWriteOnly = (
    roleIds: string[] = [mentorRole.id, adminRole.id],
  ): PermissionOverwrite[] => [
    {
      id: everyoneId,
      type: 0,
      allow: "0",
      deny: PERM_SEND_MESSAGES.toString(),
    },
    ...roleIds.map((id) => ({
      id,
      type: 0 as const,
      allow: PERM_SEND_MESSAGES.toString(),
      deny: "0",
    })),
  ];

  // ── START HERE ─────────────────────────────────────────────────────
  const startCat = await ensureChannel({
    name: "START HERE",
    type: CHANNEL_TYPE_CATEGORY,
  });
  await ensureChannel({
    name: "welcome",
    type: CHANNEL_TYPE_TEXT,
    parent_id: startCat.id,
    topic: "Welcome to batch0! Link your account at /dashboard/settings.",
    permission_overwrites: staffWriteOnly([adminRole.id]),
  });
  await ensureChannel({
    name: "rules",
    type: CHANNEL_TYPE_TEXT,
    parent_id: startCat.id,
    topic: "Community guidelines.",
    permission_overwrites: staffWriteOnly([adminRole.id]),
  });
  const announcementsCh = await ensureChannel({
    name: "announcements",
    type: CHANNEL_TYPE_TEXT,
    parent_id: startCat.id,
    topic: "Program announcements. Staff posts only.",
    permission_overwrites: staffWriteOnly(),
  });

  // ── STUDENTS ───────────────────────────────────────────────────────
  const studentsCat = await ensureChannel({
    name: "STUDENTS",
    type: CHANNEL_TYPE_CATEGORY,
  });
  await ensureChannel({
    name: "general",
    type: CHANNEL_TYPE_TEXT,
    parent_id: studentsCat.id,
  });
  const introductionsCh = await ensureChannel({
    name: "introductions",
    type: CHANNEL_TYPE_TEXT,
    parent_id: studentsCat.id,
    topic:
      "Drop a quick intro — name, what you're working on, what you want help with.",
  });
  const helpCh = await ensureChannel({
    name: "help",
    type: CHANNEL_TYPE_TEXT,
    parent_id: studentsCat.id,
    topic:
      "Stuck? Ask here. Mentors are watching. Run /queue join to enter the OH queue.",
  });
  await ensureChannel({
    name: "projects",
    type: CHANNEL_TYPE_TEXT,
    parent_id: studentsCat.id,
    topic: "Share what you're building. Demos welcome.",
  });
  const winsCh = await ensureChannel({
    name: "wins",
    type: CHANNEL_TYPE_TEXT,
    parent_id: studentsCat.id,
    topic:
      "Milestones get celebrated here. Mark a check-in as a milestone to broadcast.",
    permission_overwrites: staffWriteOnly(),
  });
  await ensureChannel({
    name: "off-topic",
    type: CHANNEL_TYPE_TEXT,
    parent_id: studentsCat.id,
  });

  // ── TEAMS (private per-team channels live here) ───────────────────
  // Each team's channels are hidden-by-default and provisioned on
  // demand by lib/team-discord.ts. The category just gives them a
  // visual home and a place to inherit permissions from.
  const teamsCat = await ensureChannel({
    name: "TEAMS",
    type: CHANNEL_TYPE_CATEGORY,
    permission_overwrites: hideExceptFor([mentorRole.id, adminRole.id]),
  });

  // ── EVENTS ─────────────────────────────────────────────────────────
  const eventsCat = await ensureChannel({
    name: "EVENTS",
    type: CHANNEL_TYPE_CATEGORY,
  });
  const eventsCh = await ensureChannel({
    name: "events",
    type: CHANNEL_TYPE_TEXT,
    parent_id: eventsCat.id,
    topic: "Upcoming batch0 events. Run /events in any channel.",
    permission_overwrites: staffWriteOnly(),
  });
  await ensureChannel({
    name: "event-chat",
    type: CHANNEL_TYPE_TEXT,
    parent_id: eventsCat.id,
    topic: "Chat during events.",
  });

  // ── INVESTORS (private) ────────────────────────────────────────────
  const investorsCat = await ensureChannel({
    name: "INVESTORS",
    type: CHANNEL_TYPE_CATEGORY,
    permission_overwrites: hideExceptFor([
      investorRole.id,
      mentorRole.id,
      adminRole.id,
    ]),
  });
  await ensureChannel({
    name: "investor-lounge",
    type: CHANNEL_TYPE_TEXT,
    parent_id: investorsCat.id,
  });

  // ── STAFF (private) ────────────────────────────────────────────────
  const staffCat = await ensureChannel({
    name: "STAFF",
    type: CHANNEL_TYPE_CATEGORY,
    permission_overwrites: hideExceptFor([mentorRole.id, adminRole.id]),
  });
  await ensureChannel({
    name: "mentor-lounge",
    type: CHANNEL_TYPE_TEXT,
    parent_id: staffCat.id,
  });
  const adminFeedCh = await ensureChannel({
    name: "admin-feed",
    type: CHANNEL_TYPE_TEXT,
    parent_id: staffCat.id,
    topic:
      "Cross-posts: applications, payments, refunds, link/unlink events.",
  });

  // ── VOICE ──────────────────────────────────────────────────────────
  const voiceCat = await ensureChannel({
    name: "VOICE",
    type: CHANNEL_TYPE_CATEGORY,
  });
  await ensureChannel({
    name: "General Voice",
    type: CHANNEL_TYPE_VOICE,
    parent_id: voiceCat.id,
  });
  const ohVoiceCh = await ensureChannel({
    name: "Office Hours",
    type: CHANNEL_TYPE_VOICE,
    parent_id: voiceCat.id,
    permission_overwrites: [
      {
        id: everyoneId,
        type: 0,
        allow: "0",
        deny: (PERM_CONNECT | PERM_SPEAK).toString(),
      },
      {
        id: studentRole.id,
        type: 0,
        allow: PERM_CONNECT.toString(),
        deny: PERM_SPEAK.toString(),
      },
      {
        id: mentorRole.id,
        type: 0,
        allow: (PERM_CONNECT | PERM_SPEAK).toString(),
        deny: "0",
      },
      {
        id: adminRole.id,
        type: 0,
        allow: (PERM_CONNECT | PERM_SPEAK).toString(),
        deny: "0",
      },
    ],
  });

  return {
    rolesCreated,
    rolesReused,
    channelsCreated,
    channelsReused,
    ids: {
      announcementsChannelId: announcementsCh.id,
      eventsChannelId: eventsCh.id,
      adminFeedChannelId: adminFeedCh.id,
      teamsCategoryId: teamsCat.id,
      winsChannelId: winsCh.id,
      helpChannelId: helpCh.id,
      ohVoiceChannelId: ohVoiceCh.id,
      introductionsChannelId: introductionsCh.id,
      roleStudentId: studentRole.id,
      roleMentorId: mentorRole.id,
      roleAdminId: adminRole.id,
      roleInvestorId: investorRole.id,
      roleFounderPassId: founderPassRole.id,
    },
  };
}

/**
 * Bring the guild up to the canonical layout WITHOUT deleting anything.
 *
 * This is the repair most servers actually need. The destructive
 * bootstrap below is for a genuinely fresh guild; once a server has
 * message history, "wipe and rebuild" is not a fix anyone can afford to
 * run. Channels and roles that were deleted out from under
 * site_settings — which is exactly what leaves the doctor reporting
 * "Deleted or wrong-guild" ids — get recreated, everything still present
 * is adopted by name, and the caller persists the returned IDs.
 */
export async function repairGuildLayout(): Promise<RepairResult> {
  if (!env.discordBotToken || !env.discordGuildId) {
    throw new Error("Need DISCORD_BOT_TOKEN and DISCORD_GUILD_ID");
  }
  return await ensureCanonicalLayout(true);
}

/**
 * Nuke the guild's existing channels + roles (except @everyone and
 * managed bot roles) and rebuild the batch0 canonical layout in
 * one shot. Caller must persist the returned IDs into site_settings.
 *
 * Throttled at ~3 ops/sec to stay clear of Discord rate limits. Expect
 * 10–30 seconds for a fresh server, longer if your guild has lots of
 * existing channels.
 */
export async function bootstrapGuildFromScratch(): Promise<BootstrapResult> {
  if (!env.discordBotToken || !env.discordGuildId) {
    throw new Error("Need DISCORD_BOT_TOKEN and DISCORD_GUILD_ID");
  }
  const guildId = env.discordGuildId;

  // Step 1: detach the system channel so deleting it doesn't error.
  await patchGuild({
    system_channel_id: null,
    rules_channel_id: null,
    public_updates_channel_id: null,
    safety_alerts_channel_id: null,
  });

  // Step 2: wipe channels. Categories and their children can be deleted
  // in any order — Discord doesn't cascade, just orphans them.
  const channels = await listGuildChannels();
  let channelsDeleted = 0;
  for (const ch of channels) {
    try {
      const ok = await deleteChannel(ch.id);
      if (ok) channelsDeleted += 1;
    } catch (err) {
      console.error("[discord] delete channel failed", ch.id, err);
    }
    await sleep(350);
  }

  // Step 3: wipe roles. Skip @everyone (id === guildId) and any
  // integration-managed roles (the bot's own role, Nitro Booster, etc.).
  const roles = await listGuildRoles();
  let rolesDeleted = 0;
  for (const r of roles) {
    if (r.id === guildId) continue; // @everyone
    if (r.managed) continue;
    try {
      const ok = await deleteRole(r.id);
      if (ok) rolesDeleted += 1;
    } catch (err) {
      console.error("[discord] delete role failed", r.id, err);
    }
    await sleep(350);
  }

  // Step 4: rebuild. Nothing survived the wipe, so nothing is reusable.
  const layout = await ensureCanonicalLayout(false);

  return { ...layout, channelsDeleted, rolesDeleted };
}

/**
 * Pull the latest username/avatar for an already-linked user via the
 * bot's guild-member endpoint and persist them. Useful for periodic
 * background refreshes (we don't keep an OAuth refresh token).
 */
export async function refreshDiscordIdentity(
  profileId: string,
  discordUserId: string,
): Promise<boolean> {
  const member = await fetchGuildMember(discordUserId);
  if (!member?.user) return false;
  try {
    const admin = createAdminClient();
    await admin
      .from("profiles")
      .update({
        discord_username: member.user.global_name ?? member.user.username,
        discord_avatar: member.user.avatar,
      })
      .eq("id", profileId);
    return true;
  } catch (err) {
    console.error("[discord] identity refresh failed", err);
    return false;
  }
}
