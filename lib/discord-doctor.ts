/**
 * Live end-to-end health check for the Discord integration.
 *
 * The "Connection status" card on /admin/discord tells you whether the env
 * vars are *present*. That is not the same as the integration *working* —
 * a valid-looking token can be revoked, a configured channel can be
 * deleted, and role sync fails silently forever if the bot's own role sits
 * below the roles it is trying to assign. Those are the failures that look
 * fine on the config page and produce nothing in Discord.
 *
 * This module answers the harder question by actually calling Discord and
 * comparing the live guild against what site_settings claims. Every request
 * here is a GET — the doctor never mutates the guild.
 */
import { env } from "@/lib/env";
import {
  getDiscordSettings,
  isDiscordEnabled,
  listRegisteredCommands,
  SLASH_COMMANDS,
  type DiscordSettings,
} from "@/lib/discord";
import type { Role } from "@/lib/types";

const API = "https://discord.com/api/v10";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export type Check = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to actually do about it. Omitted when status is ok. */
  remedy?: string;
};

export type DoctorReport = {
  ranAt: string;
  guildName: string | null;
  memberCount: number | null;
  checks: Check[];
  counts: Record<Exclude<CheckStatus, "skip">, number> & { skip: number };
};

// Discord permission bits we depend on. BigInt because the permissions
// field is 64-bit and serialized as a decimal string — Number() silently
// loses precision on the high bits.
const PERM = {
  KICK_MEMBERS: BigInt(1) << BigInt(1),
  ADMINISTRATOR: BigInt(1) << BigInt(3),
  MANAGE_CHANNELS: BigInt(1) << BigInt(4),
  VIEW_CHANNEL: BigInt(1) << BigInt(10),
  SEND_MESSAGES: BigInt(1) << BigInt(11),
  MANAGE_MESSAGES: BigInt(1) << BigInt(13),
  MENTION_EVERYONE: BigInt(1) << BigInt(17),
  CREATE_PRIVATE_THREADS: BigInt(1) << BigInt(36),
  MANAGE_ROLES: BigInt(1) << BigInt(28),
} as const;

// What each permission is actually needed FOR, so the remedy names the
// feature that breaks rather than just the bit.
const PERM_PURPOSE: Record<keyof typeof PERM, string> = {
  KICK_MEMBERS: "removing members when they unlink or are unenrolled",
  ADMINISTRATOR: "(implies everything)",
  MANAGE_CHANNELS: "creating per-team channels and running Bootstrap",
  VIEW_CHANNEL: "reading the channels it posts into",
  SEND_MESSAGES: "announcements, event posts, and the admin feed",
  MANAGE_MESSAGES: "pinning the mentors-on-call message",
  MENTION_EVERYONE: "@everyone / role pings on announcements",
  CREATE_PRIVATE_THREADS: "demo-day threads",
  MANAGE_ROLES: "granting and revoking student/mentor/founder-pass roles",
};

type GuildRole = {
  id: string;
  name: string;
  position: number;
  permissions: string;
  managed: boolean;
};

type GuildChannel = {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
};

async function get<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; status: number; body: string }> {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bot ${env.discordBotToken}` },
      cache: "no-store",
    });
    if (!res.ok) {
      return { ok: false, status: res.status, body: (await res.text()).slice(0, 300) };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err: any) {
    return { ok: false, status: 0, body: String(err?.message ?? err) };
  }
}

// Channel types we expect for each configured id — a text channel id
// pasted into the voice slot fails at send time with a confusing error.
const CHANNEL_TYPE_TEXT = 0;
const CHANNEL_TYPE_VOICE = 2;
const CHANNEL_TYPE_CATEGORY = 4;

const ROLE_LABEL: Record<Role, string> = {
  student: "Student",
  mentor: "Mentor",
  admin: "Admin",
  investor: "Investor",
};

export async function runDiscordDoctor(): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  let guildName: string | null = null;
  let memberCount: number | null = null;

  const finish = (): DoctorReport => {
    const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
    for (const c of checks) counts[c.status] += 1;
    return {
      ranAt: new Date().toISOString(),
      guildName,
      memberCount,
      checks,
      counts,
    };
  };

  // --- 0. Kill switch ------------------------------------------------------
  const enabled = await isDiscordEnabled();
  add({
    id: "kill-switch",
    label: "Integration enabled",
    status: enabled ? "ok" : "warn",
    detail: enabled
      ? "The master switch is on."
      : "The master switch is OFF — every Discord helper is short-circuiting, so nothing posts and no roles sync.",
    remedy: enabled ? undefined : "Flip the toggle at the top of this page.",
  });

  // --- 1. Credentials present ---------------------------------------------
  if (!env.discordBotToken || !env.discordGuildId) {
    add({
      id: "credentials",
      label: "Bot credentials",
      status: "fail",
      detail: `Missing ${!env.discordBotToken ? "DISCORD_BOT_TOKEN" : ""}${!env.discordBotToken && !env.discordGuildId ? " and " : ""}${!env.discordGuildId ? "DISCORD_GUILD_ID" : ""}. Nothing below can be checked.`,
      remedy: "Set the missing variable in the Vercel project env and redeploy.",
    });
    return finish();
  }

  // --- 2. Token actually authenticates ------------------------------------
  const me = await get<{ id: string; username: string }>("/users/@me");
  if (!me.ok) {
    add({
      id: "bot-token",
      label: "Bot token authenticates",
      status: "fail",
      detail: `Discord rejected the token (HTTP ${me.status}). Every Discord feature is dead right now.`,
      remedy:
        "The token was probably reset in the developer portal. Generate a new one under Bot → Reset Token and update DISCORD_BOT_TOKEN in Vercel.",
    });
    return finish();
  }
  const botUserId = me.data.id;
  add({
    id: "bot-token",
    label: "Bot token authenticates",
    status: "ok",
    detail: `Authenticated as ${me.data.username} (${botUserId}).`,
  });

  // --- 3. OAuth app identity ----------------------------------------------
  if (!env.discordClientId) {
    add({
      id: "client-id",
      label: "OAuth client id",
      status: "fail",
      detail: "DISCORD_CLIENT_ID is unset — account linking cannot start.",
      remedy: "Copy the Application ID from the developer portal into DISCORD_CLIENT_ID.",
    });
  } else if (env.discordClientId !== botUserId) {
    add({
      id: "client-id",
      label: "OAuth client id matches the bot",
      status: "fail",
      detail: `DISCORD_CLIENT_ID (${env.discordClientId}) is not this bot's application id (${botUserId}). Slash-command registration writes to one app while the token belongs to another, so commands will never appear.`,
      remedy: `Set DISCORD_CLIENT_ID to ${botUserId}, or replace the bot token with one from application ${env.discordClientId}.`,
    });
  } else {
    add({
      id: "client-id",
      label: "OAuth client id matches the bot",
      status: "ok",
      detail: "Application id and bot token belong to the same Discord app.",
    });
  }

  // --- 4. Interactions public key -----------------------------------------
  const app = await get<{ verify_key?: string; interactions_endpoint_url?: string | null }>(
    "/oauth2/applications/@me",
  );
  const expectedEndpoint = `${env.siteUrl}/api/discord/interactions`;
  if (!env.discordPublicKey) {
    add({
      id: "public-key",
      label: "Interactions public key",
      status: "fail",
      detail: "DISCORD_PUBLIC_KEY is unset, so every slash command is rejected with 401.",
      remedy: `Copy the Public Key from the developer portal into DISCORD_PUBLIC_KEY.`,
    });
  } else if (app.ok && app.data.verify_key) {
    const match = env.discordPublicKey.trim() === app.data.verify_key.trim();
    add({
      id: "public-key",
      label: "Interactions public key matches the app",
      status: match ? "ok" : "fail",
      detail: match
        ? "Signature verification will accept Discord's requests."
        : "DISCORD_PUBLIC_KEY does not match this application's verify key. Every slash command fails signature verification and Discord shows “The application did not respond.”",
      remedy: match
        ? undefined
        : "Re-copy the Public Key from the developer portal (General Information) into DISCORD_PUBLIC_KEY.",
    });
  }

  if (app.ok) {
    const live = app.data.interactions_endpoint_url ?? null;
    const matches = live != null && live.replace(/\/$/, "") === expectedEndpoint;
    add({
      id: "interactions-endpoint",
      label: "Interactions endpoint registered with Discord",
      status: live == null ? "fail" : matches ? "ok" : "warn",
      detail:
        live == null
          ? "No interactions endpoint is set on the Discord application, so slash commands can never reach this site."
          : matches
            ? `Discord will call ${live}.`
            : `Discord is configured to call ${live}, which is not this deployment's ${expectedEndpoint}.`,
      remedy:
        live != null && matches
          ? undefined
          : `Click “Point interactions endpoint here” under Operations below — it sets the URL to ${expectedEndpoint} for you. (The manual equivalent is the Interactions Endpoint URL field in the developer portal, General Information.) Discord sends a signed PING and will refuse to save the URL unless DISCORD_PUBLIC_KEY is already correct.`,
    });
  }

  // --- 5. Guild reachable --------------------------------------------------
  const guild = await get<{
    id: string;
    name: string;
    approximate_member_count?: number;
  }>(`/guilds/${env.discordGuildId}?with_counts=true`);
  if (!guild.ok) {
    add({
      id: "guild",
      label: "Guild reachable",
      status: "fail",
      detail: `Cannot read guild ${env.discordGuildId} (HTTP ${guild.status}). Either the id is wrong or the bot was removed from the server.`,
      remedy:
        "Confirm DISCORD_GUILD_ID, then re-invite the bot with the applications.commands + bot scopes.",
    });
    return finish();
  }
  guildName = guild.data.name;
  memberCount = guild.data.approximate_member_count ?? null;
  add({
    id: "guild",
    label: "Guild reachable",
    status: "ok",
    detail: `Connected to “${guild.data.name}”${memberCount != null ? ` · ${memberCount} members` : ""}.`,
  });

  // --- 6. Bot membership, permissions, and role hierarchy -----------------
  const rolesRes = await get<GuildRole[]>(`/guilds/${env.discordGuildId}/roles`);
  const botMember = await get<{ roles: string[] }>(
    `/guilds/${env.discordGuildId}/members/${botUserId}`,
  );

  let botTopPosition = -1;
  let botPerms = BigInt(0);
  const roleById = new Map<string, GuildRole>();

  if (rolesRes.ok) {
    for (const r of rolesRes.data) roleById.set(r.id, r);
    // @everyone always shares the guild id and applies to everyone.
    const everyone = roleById.get(env.discordGuildId);
    if (everyone) botPerms |= BigInt(everyone.permissions);
  }

  if (!botMember.ok) {
    add({
      id: "bot-member",
      label: "Bot is a member of the guild",
      status: "fail",
      detail: `The bot is not in “${guild.data.name}” (HTTP ${botMember.status}).`,
      remedy: "Re-invite the bot to the server with the bot + applications.commands scopes.",
    });
  } else {
    for (const rid of botMember.data.roles) {
      const r = roleById.get(rid);
      if (!r) continue;
      botPerms |= BigInt(r.permissions);
      if (r.position > botTopPosition) botTopPosition = r.position;
    }
    add({
      id: "bot-member",
      label: "Bot is a member of the guild",
      status: "ok",
      detail: `Bot holds ${botMember.data.roles.length} role(s); highest position ${botTopPosition}.`,
    });

    const isAdmin = (botPerms & PERM.ADMINISTRATOR) !== BigInt(0);
    const missing = (Object.keys(PERM) as (keyof typeof PERM)[]).filter(
      (k) => k !== "ADMINISTRATOR" && (botPerms & PERM[k]) === BigInt(0),
    );
    add({
      id: "bot-permissions",
      label: "Bot has the permissions the integration uses",
      status: isAdmin || missing.length === 0 ? "ok" : "fail",
      detail: isAdmin
        ? "Bot has Administrator, which covers everything."
        : missing.length === 0
          ? "All required permissions granted."
          : `Missing: ${missing.map((m) => `${m} (${PERM_PURPOSE[m]})`).join("; ")}.`,
      remedy:
        isAdmin || missing.length === 0
          ? undefined
          : "Grant the missing permissions to the bot's role in Server Settings → Roles.",
    });
  }

  // The hierarchy check. Discord refuses to let a bot add or remove a role
  // positioned at or above its own highest role, and returns a 403 that the
  // helpers swallow — so role sync appears to succeed and silently does
  // nothing. This is the single most common way this integration "breaks"
  // without anything looking wrong on the config page.
  if (rolesRes.ok && botMember.ok) {
    const settings = await getDiscordSettings();
    const managed: { label: string; id: string }[] = [
      ...(Object.entries(settings.roleIdByRole) as [Role, string | undefined][])
        .filter(([, id]) => Boolean(id))
        .map(([role, id]) => ({ label: `${ROLE_LABEL[role]} role`, id: id! })),
      ...(settings.founderPassRoleId
        ? [{ label: "Founder-pass role", id: settings.founderPassRoleId }]
        : []),
    ];
    const blocked = managed.filter((m) => {
      const r = roleById.get(m.id);
      return r != null && r.position >= botTopPosition;
    });
    add({
      id: "role-hierarchy",
      label: "Bot outranks every role it assigns",
      status: blocked.length === 0 ? "ok" : "fail",
      detail:
        blocked.length === 0
          ? `Bot's highest role (position ${botTopPosition}) sits above all ${managed.length} managed role(s).`
          : `Discord will silently refuse these because they sit at or above the bot's own highest role (position ${botTopPosition}): ${blocked
              .map((b) => `${b.label} “${roleById.get(b.id)!.name}” at position ${roleById.get(b.id)!.position}`)
              .join("; ")}.`,
      remedy:
        blocked.length === 0
          ? undefined
          : "In Server Settings → Roles, drag the bot's own role ABOVE these roles. No code change will fix this.",
    });
  }

  // --- 7. Every configured id still resolves ------------------------------
  if (rolesRes.ok) {
    const channelsRes = await get<GuildChannel[]>(
      `/guilds/${env.discordGuildId}/channels`,
    );
    const settings = await getDiscordSettings();

    const roleTargets: { label: string; id: string; required: boolean }[] = [
      { label: "Student role", id: settings.roleIdByRole.student ?? "", required: true },
      { label: "Mentor role", id: settings.roleIdByRole.mentor ?? "", required: true },
      { label: "Admin role", id: settings.roleIdByRole.admin ?? "", required: false },
      { label: "Investor role", id: settings.roleIdByRole.investor ?? "", required: false },
      { label: "Founder-pass role", id: settings.founderPassRoleId, required: false },
    ];

    const danglingRoles = roleTargets.filter((t) => t.id && !roleById.has(t.id));
    const unsetRequiredRoles = roleTargets.filter((t) => !t.id && t.required);
    add({
      id: "role-ids",
      label: "Configured role ids exist in the guild",
      status:
        danglingRoles.length > 0
          ? "fail"
          : unsetRequiredRoles.length > 0
            ? "warn"
            : "ok",
      detail:
        danglingRoles.length > 0
          ? `Deleted or wrong-guild role ids: ${danglingRoles.map((d) => `${d.label} (${d.id})`).join(", ")}.`
          : unsetRequiredRoles.length > 0
            ? `Not configured: ${unsetRequiredRoles.map((u) => u.label).join(", ")}.`
            : `All ${roleTargets.filter((t) => t.id).length} configured role(s) resolve.`,
      remedy:
        danglingRoles.length > 0 || unsetRequiredRoles.length > 0
          ? "Click “Repair server layout” under Operations below — it recreates the missing roles and re-points the config at them without deleting anything. You can also fix the ids by hand in the configuration form."
          : undefined,
    });

    if (channelsRes.ok) {
      const chanById = new Map(channelsRes.data.map((c) => [c.id, c]));
      const channelTargets: {
        label: string;
        id: string;
        expect: number;
        why: string;
      }[] = [
        { label: "Announcements", id: settings.announcementsChannelId, expect: CHANNEL_TYPE_TEXT, why: "announcements and the enrollment trumpet" },
        { label: "Events", id: settings.eventsChannelId, expect: CHANNEL_TYPE_TEXT, why: "event posts" },
        { label: "Admin feed", id: settings.adminFeedChannelId, expect: CHANNEL_TYPE_TEXT, why: "staff notifications" },
        { label: "Teams category", id: settings.teamsCategoryId, expect: CHANNEL_TYPE_CATEGORY, why: "per-team channels" },
        { label: "Wins", id: settings.winsChannelId, expect: CHANNEL_TYPE_TEXT, why: "milestone check-ins" },
        { label: "Help", id: settings.helpChannelId, expect: CHANNEL_TYPE_TEXT, why: "the mentors-on-call pin" },
        { label: "Office-hours voice", id: settings.ohVoiceChannelId, expect: CHANNEL_TYPE_VOICE, why: "the office-hours queue" },
        { label: "Introductions", id: settings.introductionsChannelId, expect: CHANNEL_TYPE_TEXT, why: "onboarding pings" },
      ];

      const dangling = channelTargets.filter((t) => t.id && !chanById.has(t.id));
      const wrongType = channelTargets.filter(
        (t) => t.id && chanById.has(t.id) && chanById.get(t.id)!.type !== t.expect,
      );
      const unset = channelTargets.filter((t) => !t.id);

      add({
        id: "channel-ids",
        label: "Configured channel ids exist and are the right type",
        status: dangling.length > 0 || wrongType.length > 0 ? "fail" : unset.length > 0 ? "warn" : "ok",
        detail: [
          dangling.length > 0
            ? `Deleted or wrong-guild: ${dangling.map((d) => `${d.label} (${d.id}) — breaks ${d.why}`).join("; ")}.`
            : "",
          wrongType.length > 0
            ? `Wrong channel type: ${wrongType
                .map(
                  (w) =>
                    `${w.label} points at “${chanById.get(w.id)!.name}” (type ${chanById.get(w.id)!.type}, expected ${w.expect})`,
                )
                .join("; ")}.`
            : "",
          unset.length > 0 ? `Not configured: ${unset.map((u) => `${u.label} (${u.why} is off)`).join("; ")}.` : "",
          dangling.length === 0 && wrongType.length === 0 && unset.length === 0
            ? `All ${channelTargets.length} channels resolve to live objects of the expected type.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        remedy:
          dangling.length > 0 || wrongType.length > 0 || unset.length > 0
            ? "Click “Repair server layout” under Operations below — it recreates the missing channels and re-points the config at them without deleting anything. You can also correct the ids by hand in the configuration form."
            : undefined,
      });

      // The teams category must actually be able to hold more channels.
      const cat = settings.teamsCategoryId ? chanById.get(settings.teamsCategoryId) : undefined;
      if (cat) {
        const children = channelsRes.data.filter((c) => c.parent_id === cat.id).length;
        add({
          id: "teams-category-capacity",
          label: "Teams category has room for new team channels",
          status: children >= 50 ? "fail" : children >= 45 ? "warn" : "ok",
          detail: `“${cat.name}” holds ${children}/50 channels (Discord's hard per-category limit).`,
          remedy:
            children >= 45
              ? "Archive finished teams' channels or move them out of the category — provisioning fails once it hits 50."
              : undefined,
        });
      }
    }

    // --- 8. Announcement delivery path ------------------------------------
    const hasChannel = Boolean(settings.announcementsChannelId);
    const hasWebhook = Boolean(env.discordAnnouncementsWebhook);
    add({
      id: "announce-path",
      label: "Announcements have a delivery path",
      status: hasChannel || hasWebhook ? "ok" : "fail",
      detail: hasChannel
        ? "Posting via the bot into the configured announcements channel."
        : hasWebhook
          ? "No announcements channel configured — falling back to the legacy DISCORD_ANNOUNCEMENTS_WEBHOOK."
          : "Neither an announcements channel nor DISCORD_ANNOUNCEMENTS_WEBHOOK is set, so announcements and enrollment notices go nowhere.",
      remedy:
        hasChannel || hasWebhook
          ? undefined
          : "Set the announcements channel id in the form below.",
    });
  }

  // --- 9. Slash commands in sync -----------------------------------------
  const registered = await listRegisteredCommands();
  if (registered == null) {
    add({
      id: "slash-commands",
      label: "Slash commands registered",
      status: "fail",
      detail: "Could not list the application's commands.",
      remedy: "Check DISCORD_CLIENT_ID and the bot token, then use “Register slash commands”.",
    });
  } else {
    const live = new Set(registered.map((c) => c.name));
    const spec: string[] = SLASH_COMMANDS.map((c) => c.name);
    const missing = spec.filter((n) => !live.has(n));
    const extra = registered.map((c) => c.name).filter((n) => !spec.includes(n));
    add({
      id: "slash-commands",
      label: "Slash commands match the spec",
      status: missing.length > 0 ? "fail" : extra.length > 0 ? "warn" : "ok",
      detail: [
        missing.length > 0 ? `Not registered with Discord: /${missing.join(", /")}.` : "",
        extra.length > 0 ? `Registered but no longer in the spec: /${extra.join(", /")}.` : "",
        missing.length === 0 && extra.length === 0
          ? `All ${spec.length} commands registered.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      remedy:
        missing.length > 0 || extra.length > 0
          ? "Click “Register slash commands” in the Operations panel — it overwrites the full set."
          : undefined,
    });
  }

  // --- 10. The public invite students click ------------------------------
  await checkInvite(add);

  return finish();
}

/**
 * The invite link on the community page is stored in site_settings, not env,
 * and nothing else validates it. An expired or revoked invite is invisible
 * to staff but is a dead end for every student who clicks it.
 */
async function checkInvite(add: (c: Check) => void) {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  let url = "";
  try {
    const { data } = await createAdminClient()
      .from("site_settings")
      .select("value")
      .eq("key", "discord_url")
      .maybeSingle();
    url = typeof data?.value === "string" ? data.value : "";
  } catch {
    // fall through to the unset branch
  }

  if (!url) {
    add({
      id: "invite",
      label: "Public invite link",
      status: "warn",
      detail: "No discord_url is set, so the community page has no join link.",
      remedy: "Set the invite URL in Admin → Settings.",
    });
    return;
  }

  const code = url.trim().replace(/\/+$/, "").split("/").pop() ?? "";
  if (!code) {
    add({
      id: "invite",
      label: "Public invite link",
      status: "fail",
      detail: `discord_url (“${url}”) is not a parseable invite URL.`,
      remedy: "Use a link of the form https://discord.gg/<code>.",
    });
    return;
  }

  try {
    // Invite resolution is unauthenticated — no bot token needed.
    const res = await fetch(
      `${API}/invites/${encodeURIComponent(code)}?with_expiration=true`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      add({
        id: "invite",
        label: "Public invite link resolves",
        status: "fail",
        detail: `Discord rejected invite “${code}” (HTTP ${res.status}) — it is expired, revoked, or mistyped. Every student who clicks Join hits a dead link.`,
        remedy: "Create a new never-expiring invite in Discord and update it in Admin → Settings.",
      });
      return;
    }
    const data = (await res.json()) as {
      expires_at: string | null;
      guild?: { id: string; name: string };
    };
    const wrongGuild =
      data.guild?.id != null &&
      env.discordGuildId != null &&
      data.guild.id !== env.discordGuildId;
    add({
      id: "invite",
      label: "Public invite link resolves",
      status: wrongGuild ? "fail" : data.expires_at ? "warn" : "ok",
      detail: wrongGuild
        ? `The invite points at “${data.guild?.name}” (${data.guild?.id}), which is not the configured guild ${env.discordGuildId}. Students join the wrong server and never get roles.`
        : data.expires_at
          ? `Invite is valid but EXPIRES at ${data.expires_at}. It will become a dead link.`
          : `Invite resolves to “${data.guild?.name}” and never expires.`,
      remedy: wrongGuild
        ? "Replace discord_url with an invite to the configured guild."
        : data.expires_at
          ? "Replace it with a never-expiring invite."
          : undefined,
    });
  } catch (err: any) {
    add({
      id: "invite",
      label: "Public invite link resolves",
      status: "warn",
      detail: `Could not check the invite: ${String(err?.message ?? err)}.`,
    });
  }
}
