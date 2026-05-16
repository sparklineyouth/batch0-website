import { NextResponse } from "next/server";
import {
  verifyInteractionSignature,
  postChannelMessage,
  announcementEmbed,
  eventEmbed,
  getDiscordSettings,
  isDiscordEnabled,
  syncMemberRoles,
  SLASH_COMMANDS,
} from "@/lib/discord";
import type { Role } from "@/lib/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Discord interaction type + response constants from
// https://discord.com/developers/docs/interactions/receiving-and-responding
const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const EPHEMERAL_FLAG = 1 << 6;

function ephemeral(content: string) {
  return NextResponse.json({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL_FLAG },
  });
}

function publicReply(content: string, embeds?: Record<string, any>[]) {
  return NextResponse.json({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, embeds, allowed_mentions: { parse: [] } },
  });
}

export async function POST(req: Request) {
  const raw = await req.text();
  const ts = req.headers.get("x-signature-timestamp");
  // Discord's signature alone is replayable forever — also require the
  // signed timestamp to be within 5 minutes of now so a captured payload
  // can't be replayed long after the fact.
  const tsNum = ts ? parseInt(ts, 10) : NaN;
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    return new NextResponse("Stale request", { status: 401 });
  }
  const ok = await verifyInteractionSignature(
    raw,
    req.headers.get("x-signature-ed25519"),
    ts,
  );
  if (!ok) {
    return new NextResponse("Bad signature", { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse("Bad body", { status: 400 });
  }

  if (body.type === PING) {
    // Always answer PING so Discord's endpoint check passes even
    // while the integration is paused.
    return NextResponse.json({ type: PONG });
  }
  if (body.type !== APPLICATION_COMMAND) {
    return ephemeral("Unsupported interaction type.");
  }

  // After PING, refuse commands when the master toggle is off.
  if (!(await isDiscordEnabled())) {
    return ephemeral("SparkLine Youth's Discord integration is paused right now.");
  }

  const name: string = body.data?.name ?? "";
  const discordUserId: string =
    body.member?.user?.id ?? body.user?.id ?? "";
  // Discord sends us the caller's current username/avatar on every
  // interaction. Persist any drift so the dashboard card stays in sync
  // without us hitting /users/@me again.
  const interactionUser = body.member?.user ?? body.user;

  // Throttle commands per Discord user. /announce is the heaviest
  // (fan-out to all enrolled + announcements channel + email) so it
  // gets a tighter budget than read-only commands.
  if (discordUserId) {
    const limit = name === "announce" ? 5 : 20;
    const rl = await checkRateLimit({
      kind: `discord-cmd-${name || "unknown"}`,
      identifier: discordUserId,
      limit,
      windowSeconds: 60,
    });
    if (!rl.ok) {
      return ephemeral(
        "You're sending commands too fast. Try again in a minute.",
      );
    }
  }

  const admin = createAdminClient();

  // Passive identity refresh — best-effort and silently ignored if the
  // user isn't linked yet.
  if (discordUserId && interactionUser) {
    admin
      .from("profiles")
      .update({
        discord_username:
          interactionUser.global_name ?? interactionUser.username ?? null,
        discord_avatar: interactionUser.avatar ?? null,
      })
      .eq("discord_user_id", discordUserId)
      .then(() => {}, () => {});
  }

  if (name === "me") {
    return await handleMe(admin, discordUserId);
  }
  if (name === "link") {
    return ephemeral(
      `🔗 Link your Discord account to SparkLine Youth: ${env.siteUrl}/dashboard/settings`,
    );
  }
  if (name === "cohort") {
    return await handleCohort(admin, discordUserId);
  }
  if (name === "events") {
    return await handleEvents(admin, discordUserId);
  }
  if (name === "sync") {
    return await handleSync(admin, discordUserId);
  }
  if (name === "whois") {
    return await handleWhois(admin, discordUserId, body);
  }
  if (name === "help") {
    return handleHelp();
  }
  if (name === "announce") {
    return await handleAnnounce(admin, discordUserId, body);
  }

  return ephemeral(`Unknown command: \`${name}\``);
}

function handleHelp() {
  const lines = SLASH_COMMANDS.map((c) => `• \`/${c.name}\` — ${c.description}`);
  return ephemeral(["**SparkLine Youth slash commands**", ...lines].join("\n"));
}

async function handleSync(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
) {
  if (!discordUserId) return ephemeral("Couldn't identify you.");
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!profile) {
    return ephemeral(
      `You haven't linked yet — link first: ${env.siteUrl}/dashboard/settings`,
    );
  }
  try {
    await syncMemberRoles(discordUserId, (profile.role as Role) ?? "student");
    return ephemeral(`✅ Synced. Your role is **${profile.role}**.`);
  } catch (err) {
    console.error("[discord] /sync failed", err);
    return ephemeral("Sync failed. Try again or ping an admin.");
  }
}

async function handleEvents(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
) {
  // Scope to caller's cohort if they're enrolled; otherwise show
  // public events. Either way limit to 5 upcoming.
  let cohortId: string | null = null;
  if (discordUserId) {
    const { data: profile } = await admin
      .from("profiles")
      .select("id")
      .eq("discord_user_id", discordUserId)
      .maybeSingle();
    if (profile) {
      const { data: enrollment } = await admin
        .from("enrollments")
        .select("cohort_id")
        .eq("user_id", profile.id)
        .maybeSingle();
      cohortId = (enrollment as any)?.cohort_id ?? null;
    }
  }
  const nowIso = new Date().toISOString();
  let q = admin
    .from("events")
    .select("title, type, starts_at, ends_at, location, zoom_url, description, visibility, cohort:cohorts(name)")
    .gte("starts_at", nowIso)
    .order("starts_at", { ascending: true })
    .limit(5);
  if (cohortId) {
    // Cohort-specific OR cohort-wide (cohort_id null) events.
    q = q.or(`cohort_id.eq.${cohortId},cohort_id.is.null`);
  } else {
    q = q.eq("visibility", "public");
  }
  const { data: events } = await q;
  if (!events || events.length === 0) {
    return ephemeral("No upcoming events on the calendar.");
  }
  const embeds = (events as any[]).map((e) => {
    const cohort = Array.isArray(e.cohort) ? e.cohort[0] : e.cohort;
    return eventEmbed({
      title: e.title,
      description: e.description,
      startsAt: e.starts_at,
      endsAt: e.ends_at,
      location: e.location,
      zoomUrl: e.zoom_url,
      type: e.type,
      cohortName: cohort?.name ?? null,
    });
  });
  return NextResponse.json({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { embeds, flags: EPHEMERAL_FLAG },
  });
}

async function handleWhois(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
  body: any,
) {
  if (!discordUserId) return ephemeral("Couldn't identify you.");
  const { data: caller } = await admin
    .from("profiles")
    .select("role")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!caller || (caller.role !== "admin" && caller.role !== "mentor")) {
    return ephemeral("Only admins and mentors can run /whois.");
  }
  const userOpt = (body.data?.options ?? []).find((o: any) => o.name === "user");
  const targetDiscordId: string | undefined = userOpt?.value;
  if (!targetDiscordId) return ephemeral("Pick a user to look up.");
  // Discord ferries the target user object inside data.resolved.users
  // — handy fallback when the user isn't linked.
  const resolvedUser = body.data?.resolved?.users?.[targetDiscordId] as
    | { username?: string; global_name?: string | null }
    | undefined;

  const { data: target } = await admin
    .from("profiles")
    .select("full_name, email, role, discord_username, discord_linked_at")
    .eq("discord_user_id", targetDiscordId)
    .maybeSingle();
  if (!target) {
    const tag = resolvedUser?.global_name ?? resolvedUser?.username ?? "user";
    return ephemeral(`<@${targetDiscordId}> (\`${tag}\`) hasn't linked a SparkLine Youth account.`);
  }
  const lines = [
    `<@${targetDiscordId}> — **${target.full_name ?? target.email}**`,
    `Role: \`${target.role}\``,
    target.email ? `Email: ${target.email}` : "",
    target.discord_linked_at
      ? `Linked: <t:${Math.floor(new Date(target.discord_linked_at).getTime() / 1000)}:R>`
      : "",
  ].filter(Boolean);
  return ephemeral(lines.join("\n"));
}

async function handleMe(admin: ReturnType<typeof createAdminClient>, discordUserId: string) {
  if (!discordUserId) return ephemeral("Couldn't identify you.");
  const { data: profile } = await admin
    .from("profiles")
    .select("id, full_name, email, role")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!profile) {
    return ephemeral(
      `You haven't linked your account yet. Link at ${env.siteUrl}/dashboard/settings`,
    );
  }
  const [{ data: app }, { data: enrollment }, { data: pending }] = await Promise.all([
    admin
      .from("applications")
      .select("status, cohort:cohorts(name)")
      .eq("user_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("enrollments")
      .select("cohort:cohorts(name)")
      .eq("user_id", profile.id)
      .maybeSingle(),
    admin
      .from("user_charges")
      .select("amount_cents, kind")
      .eq("user_id", profile.id)
      .eq("status", "pending"),
  ]);
  const lines = [
    `**${profile.full_name ?? profile.email}** · role: \`${profile.role}\``,
  ];
  if (app) {
    const a = app as any;
    const cohort = Array.isArray(a.cohort) ? a.cohort[0] : a.cohort;
    lines.push(
      `Application: \`${a.status}\`${cohort?.name ? ` · ${cohort.name}` : ""}`,
    );
  }
  if (enrollment) {
    const e = enrollment as any;
    const cohort = Array.isArray(e.cohort) ? e.cohort[0] : e.cohort;
    if (cohort?.name) lines.push(`Enrolled in **${cohort.name}**`);
  }
  if ((pending?.length ?? 0) > 0) {
    const total = (pending ?? []).reduce(
      (s, r: any) => s + (r.amount_cents ?? 0),
      0,
    );
    lines.push(
      `⚠️ ${pending!.length} pending charge${pending!.length === 1 ? "" : "s"} · $${(total / 100).toFixed(2)}`,
    );
  }
  lines.push(`Dashboard: ${env.siteUrl}/dashboard`);
  return ephemeral(lines.join("\n"));
}

async function handleCohort(admin: ReturnType<typeof createAdminClient>, discordUserId: string) {
  const { data: profile } = await admin
    .from("profiles")
    .select("id, role")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!profile) return ephemeral("Link your account first.");

  const { data: enrollment } = await admin
    .from("enrollments")
    .select("cohort:cohorts(name, starts_on, ends_on, status)")
    .eq("user_id", profile.id)
    .maybeSingle();
  const cohort = enrollment
    ? (Array.isArray((enrollment as any).cohort)
        ? (enrollment as any).cohort[0]
        : (enrollment as any).cohort)
    : null;
  if (!cohort) return ephemeral("You're not enrolled in a cohort yet.");

  const { count: enrolledCount } = await admin
    .from("enrollments")
    .select("id", { count: "exact", head: true })
    .eq("cohort_id", (enrollment as any).cohort_id ?? "");

  return ephemeral(
    [
      `**${cohort.name}** · ${cohort.status}`,
      cohort.starts_on ? `Runs ${cohort.starts_on} → ${cohort.ends_on ?? "—"}` : "",
      enrolledCount != null ? `${enrolledCount} enrolled` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function handleAnnounce(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
  body: any,
) {
  if (!discordUserId) return ephemeral("Couldn't identify you.");
  const { data: profile } = await admin
    .from("profiles")
    .select("id, role")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!profile || profile.role !== "admin") {
    return ephemeral("Only admins can run /announce.");
  }
  const opts: { name: string; value: string }[] = body.data?.options ?? [];
  const title = opts.find((o) => o.name === "title")?.value?.trim() ?? "";
  const messageBody = opts.find((o) => o.name === "message")?.value?.trim() ?? "";
  if (!title || !messageBody) {
    return ephemeral("Need both `title` and `message`.");
  }
  // Mirror the post to Discord's announcements channel (rich embed).
  const settings = await getDiscordSettings();
  if (settings.announcementsChannelId) {
    await postChannelMessage(settings.announcementsChannelId, {
      embeds: [
        announcementEmbed({ title, body: messageBody, link: `${env.siteUrl}/dashboard` }),
      ],
    });
  }
  // Also reflect to the website by inserting a notification fan-out.
  const { data: students } = await admin
    .from("enrollments")
    .select("user_id");
  if ((students?.length ?? 0) > 0) {
    await admin.from("notifications").insert(
      (students ?? []).map((s: any) => ({
        user_id: s.user_id,
        type: "announcement",
        title,
        body: messageBody.slice(0, 240),
        link: "/dashboard",
      })),
    );
  }
  return ephemeral(
    `Posted to ${students?.length ?? 0} student${students?.length === 1 ? "" : "s"} + the announcements channel.`,
  );
}
