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
  modalResponse,
  buttonRow,
  sendInteractionFollowup,
  sendDirectMessage,
  startThreadFromMessage,
  InteractionResponseType,
  MessageFlag,
} from "@/lib/discord";
import type { Role } from "@/lib/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import { isoWeekStart } from "@/lib/week";
import { notifyMany } from "@/lib/notifications";
import {
  sendOnboardingDM,
  currentOncall,
  refreshOncallPin,
} from "@/lib/discord-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Discord interaction types
//   1 = PING                    (Discord pings the endpoint on save)
//   2 = APPLICATION_COMMAND     (slash or message context menu)
//   3 = MESSAGE_COMPONENT       (button click / select menu)
//   5 = MODAL_SUBMIT            (user submitted a modal we showed)
const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const INTERACTION_MESSAGE_COMPONENT = 3;
const INTERACTION_MODAL_SUBMIT = 5;

const ephemeralFlag = MessageFlag.EPHEMERAL;

function ephemeral(content: string) {
  return NextResponse.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: ephemeralFlag },
  });
}

function publicReply(content: string, embeds?: Record<string, any>[]) {
  return NextResponse.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, embeds, allowed_mentions: { parse: [] } },
  });
}

function deferEphemeral() {
  // ACK Discord within 3s — we'll edit the response with the real
  // payload via the followup endpoint.
  return NextResponse.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: ephemeralFlag },
  });
}

function ack() {
  // For button clicks where we don't need to say anything.
  return NextResponse.json({
    type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE,
  });
}

// Extract a sub-command + its options from a Discord slash payload.
function readSubCommand(body: any): { sub: string | null; options: Map<string, any> } {
  const top = body?.data?.options ?? [];
  const first = Array.isArray(top) ? top[0] : null;
  if (!first || first.type !== 1) {
    const map = new Map<string, any>();
    for (const o of top) map.set(o.name, o.value);
    return { sub: null, options: map };
  }
  const map = new Map<string, any>();
  for (const o of first.options ?? []) map.set(o.name, o.value);
  return { sub: first.name as string, options: map };
}

export async function POST(req: Request) {
  const raw = await req.text();
  const ts = req.headers.get("x-signature-timestamp");
  const tsNum = ts ? parseInt(ts, 10) : NaN;
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    return new NextResponse("Stale request", { status: 401 });
  }
  const okSig = await verifyInteractionSignature(
    raw,
    req.headers.get("x-signature-ed25519"),
    ts,
  );
  if (!okSig) {
    return new NextResponse("Bad signature", { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse("Bad body", { status: 400 });
  }

  if (body.type === INTERACTION_PING) {
    return NextResponse.json({ type: 1 });
  }

  if (!(await isDiscordEnabled())) {
    return ephemeral("batch0's Discord integration is paused right now.");
  }

  const admin = createAdminClient();
  const discordUserId: string =
    body.member?.user?.id ?? body.user?.id ?? "";
  const interactionUser = body.member?.user ?? body.user;

  // Passive identity refresh — best-effort, swallow errors.
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

  // ── Slash + context menu commands ────────────────────────────────────────
  if (body.type === INTERACTION_APPLICATION_COMMAND) {
    const name: string = body.data?.name ?? "";

    // Rate limit per (user, command). Heavier commands get tighter budgets.
    if (discordUserId) {
      const heavy = ["announce", "ask"].includes(name);
      const rl = await checkRateLimit({
        kind: `discord-cmd-${name || "unknown"}`,
        identifier: discordUserId,
        limit: heavy ? 5 : 20,
        windowSeconds: 60,
      });
      if (!rl.ok) {
        return ephemeral("You're sending commands too fast. Try again in a minute.");
      }
    }

    // type 3 = MESSAGE context menu. data.name will be our label.
    if (body.data?.type === 3 && name === "🆘 Flag as Blocker") {
      return await handleFlagBlocker(admin, discordUserId, body);
    }

    switch (name) {
      case "me":
        return await handleMe(admin, discordUserId);
      case "link":
        return ephemeral(
          `🔗 Link your Discord account to batch0: ${env.siteUrl}/dashboard/settings`,
        );
      case "cohort":
        return await handleCohort(admin, discordUserId);
      case "events":
        return await handleEvents(admin, discordUserId);
      case "sync":
        return await handleSync(admin, discordUserId);
      case "whois":
        return await handleWhois(admin, discordUserId, body);
      case "help":
        return handleHelp();
      case "announce":
        return await handleAnnounce(admin, discordUserId, body);
      case "checkin":
        return handleCheckinModalOpen();
      case "team":
        return await handleTeam(admin, discordUserId);
      case "ask":
        return await handleAsk(admin, discordUserId, body);
      case "start":
        return await handleStart(admin, discordUserId);
      case "queue":
        return await handleQueue(admin, discordUserId, body);
      case "oncall":
        return await handleOncall(admin, discordUserId, body);
      default:
        return ephemeral(`Unknown command: \`${name}\``);
    }
  }

  // ── Button clicks ────────────────────────────────────────────────────────
  if (body.type === INTERACTION_MESSAGE_COMPONENT) {
    const customId: string = body.data?.custom_id ?? "";
    if (customId.startsWith("rsvp:")) {
      return await handleRsvpClick(admin, discordUserId, body, customId);
    }
    if (customId.startsWith("ddreact:")) {
      return await handleDemoDayReact(admin, discordUserId, body, customId);
    }
    if (customId.startsWith("onb:")) {
      return await handleOnboardingClick(admin, discordUserId, body, customId);
    }
    return ack();
  }

  // ── Modal submissions ────────────────────────────────────────────────────
  if (body.type === INTERACTION_MODAL_SUBMIT) {
    const customId: string = body.data?.custom_id ?? "";
    if (customId === "checkin-modal") {
      return await handleCheckinModalSubmit(admin, discordUserId, body);
    }
    return ephemeral("Form submitted, but I don't know what to do with it.");
  }

  return ephemeral("Unsupported interaction type.");
}

// ===========================================================================
// Existing command handlers (kept from previous implementation)
// ===========================================================================

function handleHelp() {
  const lines = SLASH_COMMANDS.map((c) => {
    const isCtx = (c as any).type === 3;
    const prefix = isCtx ? "• Message context: " : "• `/";
    const suffix = isCtx ? "" : "`";
    return `${prefix}${c.name}${suffix}${(c as any).description ? " — " + (c as any).description : ""}`;
  });
  return ephemeral(["**batch0 commands**", ...lines].join("\n"));
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
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { embeds, flags: ephemeralFlag },
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
    return ephemeral(`<@${targetDiscordId}> (\`${tag}\`) hasn't linked a batch0 account.`);
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
    .select("cohort_id, cohort:cohorts(name, starts_on, ends_on, status)")
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
  const settings = await getDiscordSettings();
  if (settings.announcementsChannelId) {
    await postChannelMessage(settings.announcementsChannelId, {
      embeds: [
        announcementEmbed({ title, body: messageBody, link: `${env.siteUrl}/dashboard` }),
      ],
    });
  }
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

// ===========================================================================
// /checkin — open a modal, then write the result into student_checkins
// ===========================================================================

function handleCheckinModalOpen() {
  return NextResponse.json(
    modalResponse({
      customId: "checkin-modal",
      title: "Weekly check-in",
      components: [
        {
          customId: "accomplished",
          label: "What did you ship this week?",
          placeholder: "Most important wins or progress.",
          required: true,
          maxLength: 4000,
        },
        {
          customId: "next_up",
          label: "What's next?",
          placeholder: "Top priorities for the coming week.",
          required: false,
          maxLength: 4000,
        },
        {
          customId: "blockers",
          label: "Any blockers?",
          placeholder: "Stuck on anything? Who can help?",
          required: false,
          maxLength: 4000,
        },
        {
          customId: "milestone",
          label: "Major milestone? (yes/no)",
          placeholder: "Type 'yes' if this is a big-deal moment.",
          required: false,
          maxLength: 5,
          style: 1, // short
        },
      ],
    }),
  );
}

async function handleCheckinModalSubmit(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
  body: any,
) {
  if (!discordUserId) return ephemeral("Couldn't identify you.");
  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!profile) {
    return ephemeral(`Link your account first: ${env.siteUrl}/dashboard/settings`);
  }
  // enrollment is required for check-ins
  const { data: enrollment } = await admin
    .from("enrollments")
    .select("cohort_id")
    .eq("user_id", profile.id)
    .maybeSingle();
  if (!enrollment) {
    return ephemeral("You need to be enrolled in a cohort to post a check-in.");
  }

  const valuesById = new Map<string, string>();
  for (const row of body.data?.components ?? []) {
    for (const comp of row.components ?? []) {
      if (typeof comp.value === "string") {
        valuesById.set(comp.custom_id, comp.value);
      }
    }
  }
  const accomplished = (valuesById.get("accomplished") ?? "").trim().slice(0, 4000);
  const next_up = (valuesById.get("next_up") ?? "").trim().slice(0, 4000);
  const blockers = (valuesById.get("blockers") ?? "").trim().slice(0, 4000);
  const milestoneRaw = (valuesById.get("milestone") ?? "").trim().toLowerCase();
  const is_milestone = /^(y|yes|true|1)$/.test(milestoneRaw);

  if (!accomplished && !next_up && !blockers) {
    return ephemeral("Add at least one section before submitting.");
  }

  const week_start = isoWeekStart();
  const payload = {
    user_id: profile.id,
    cohort_id: enrollment.cohort_id ?? null,
    week_start,
    accomplished: accomplished || null,
    next_up: next_up || null,
    blockers: blockers || null,
    is_milestone,
  };
  const { error } = await admin
    .from("student_checkins")
    .upsert(payload, { onConflict: "user_id,week_start" });
  if (error) {
    console.error("[discord] checkin upsert failed", error);
    return ephemeral("Couldn't save your check-in. Try the website instead.");
  }

  // Best-effort: ping staff in-app, like the website flow does.
  try {
    const { data: staff } = await admin
      .from("profiles")
      .select("id")
      .in("role", ["mentor", "admin"]);
    const { data: prof2 } = await admin
      .from("profiles")
      .select("full_name, email")
      .eq("id", profile.id)
      .maybeSingle();
    const name = prof2?.full_name ?? prof2?.email ?? "A student";
    await notifyMany(
      (staff ?? [])
        .filter((s: any) => s.id !== profile.id)
        .map((s: any) => ({
          userId: s.id,
          type: "checkin_submitted",
          title: `${name} posted this week's check-in`,
          body: accomplished ? accomplished.slice(0, 160) : null,
          link: `/mentor/checkins?week=${week_start}`,
        })),
    );
  } catch {}

  // If marked milestone, cross-post to #wins (best-effort).
  if (is_milestone) {
    await crosspostMilestone(admin, profile.id, accomplished, next_up);
  }

  return ephemeral(
    is_milestone
      ? "✅ Check-in saved. Tagged as a milestone — I'll celebrate it in #wins."
      : "✅ Check-in saved.",
  );
}

// ===========================================================================
// /team — quick snapshot of the caller's team
// ===========================================================================

async function handleTeam(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
) {
  if (!discordUserId) return ephemeral("Couldn't identify you.");
  const { data: profile } = await admin
    .from("profiles")
    .select("id, full_name")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!profile) return ephemeral("Link your account first.");

  const { data: membership } = await admin
    .from("team_members")
    .select("team_id, role")
    .eq("user_id", profile.id)
    .maybeSingle();
  if (!membership) {
    return ephemeral(`You aren't on a team yet. Start or join one at ${env.siteUrl}/dashboard/team`);
  }

  const [{ data: team }, { data: members }] = await Promise.all([
    admin
      .from("teams")
      .select("name, slug, tagline, cohort_id, cohort:cohorts(name)")
      .eq("id", membership.team_id)
      .maybeSingle(),
    admin
      .from("team_members")
      .select("user_id, role, profile:profiles(full_name, email)")
      .eq("team_id", membership.team_id),
  ]);

  const memberIds = (members ?? []).map((m: any) => m.user_id);
  // Recent check-ins and next event depend on the queries above, so fetch
  // them after we have the cohort + member set.
  const [recentCheckinsRes, nextEventRes] = await Promise.all([
    memberIds.length > 0
      ? admin
          .from("student_checkins")
          .select("week_start, accomplished, profile:profiles(full_name)")
          .in("user_id", memberIds)
          .order("week_start", { ascending: false })
          .limit(3)
      : Promise.resolve({ data: [] as any[] } as any),
    (team as any)?.cohort_id
      ? admin
          .from("events")
          .select("title, starts_at")
          .or(
            `cohort_id.eq.${(team as any).cohort_id},cohort_id.is.null`,
          )
          .gte("starts_at", new Date().toISOString())
          .order("starts_at", { ascending: true })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null } as any),
  ]);
  const recentCheckins = (recentCheckinsRes as any).data ?? [];
  const nextEvent = (nextEventRes as any).data ?? null;

  const cohort = team
    ? Array.isArray((team as any).cohort)
      ? (team as any).cohort[0]
      : (team as any).cohort
    : null;

  const memberLines = (members ?? []).map((m: any) => {
    const prof = Array.isArray(m.profile) ? m.profile[0] : m.profile;
    return `• ${prof?.full_name ?? prof?.email ?? "Member"} (${m.role})`;
  });

  const checkinLines = recentCheckins.map((c: any) => {
    const prof = Array.isArray(c.profile) ? c.profile[0] : c.profile;
    return `• **${prof?.full_name ?? "Member"}** (week of ${c.week_start}): ${(
      c.accomplished ?? ""
    ).slice(0, 120) || "—"}`;
  });

  const evt = nextEvent
    ? (() => {
        const e: any = nextEvent;
        const epoch = Math.floor(new Date(e.starts_at).getTime() / 1000);
        return `${e.title} · <t:${epoch}:R>`;
      })()
    : null;

  const lines = [
    `**${(team as any)?.name ?? "Your team"}**${cohort?.name ? ` · ${cohort.name}` : ""}`,
    (team as any)?.tagline ? `_${(team as any).tagline}_` : "",
    "",
    "**Members**",
    ...(memberLines.length ? memberLines : ["• (no members)"]),
    "",
    "**Recent check-ins**",
    ...(checkinLines.length ? checkinLines : ["• No check-ins yet this cohort"]),
    "",
    evt ? `**Next event:** ${evt}` : "",
    `Open team: ${env.siteUrl}/dashboard/team`,
  ].filter(Boolean);
  return ephemeral(lines.join("\n"));
}

// ===========================================================================
// /ask — proxy a question to the AI co-founder
// ===========================================================================

async function handleAsk(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
  body: any,
) {
  const applicationId: string = body.application_id;
  const token: string = body.token;
  const question: string =
    (body.data?.options ?? []).find((o: any) => o.name === "question")?.value ?? "";
  if (!question.trim()) return ephemeral("Pass a question.");
  if (!discordUserId) return ephemeral("Couldn't identify you.");

  const { data: profile } = await admin
    .from("profiles")
    .select("id, role")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!profile) {
    return ephemeral(`Link your account first: ${env.siteUrl}/dashboard/settings`);
  }

  // Fire-and-forget the AI work behind a defer so we ack Discord in <3s.
  void runAsk(admin, profile.id, question.trim(), applicationId, token);
  return deferEphemeral();
}

async function runAsk(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  question: string,
  applicationId: string,
  token: string,
) {
  try {
    if (!env.anthropicApiKey) {
      await sendInteractionFollowup({
        applicationId,
        interactionToken: token,
        content: "The AI co-founder isn't configured on this server.",
        ephemeral: true,
      });
      return;
    }
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: env.anthropicApiKey });

    // Pull light context: the user's team retrieval if any.
    const { data: membership } = await admin
      .from("team_members")
      .select("team_id, team:teams(name, tagline, description)")
      .eq("user_id", userId)
      .maybeSingle();
    const team = membership
      ? Array.isArray((membership as any).team)
        ? (membership as any).team[0]
        : (membership as any).team
      : null;

    const systemBits: string[] = [
      "You are the batch0 AI co-founder, a no-fluff advisor for high-school startup founders. Be concise and concrete.",
    ];
    if (team) {
      systemBits.push(
        `The asker is on team "${team.name}"${
          team.tagline ? ` (${team.tagline})` : ""
        }${team.description ? `: ${String(team.description).slice(0, 400)}` : ""}.`,
      );
    }
    systemBits.push(
      "Keep replies under 400 words. Use plain text — Discord chops markdown lists.",
    );

    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      system: systemBits.join(" "),
      messages: [{ role: "user", content: question.slice(0, 4000) }],
    });
    const text = res.content
      .map((b: any) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    await sendInteractionFollowup({
      applicationId,
      interactionToken: token,
      content: text.slice(0, 1900) || "(no response — try again)",
      ephemeral: true,
    });
  } catch (err) {
    console.error("[discord] /ask failed", err);
    await sendInteractionFollowup({
      applicationId,
      interactionToken: token,
      content: "Something went wrong asking the AI. Try the dashboard.",
      ephemeral: true,
    });
  }
}

// ===========================================================================
// /start — (re-)run the onboarding wizard via DM
// ===========================================================================

async function handleStart(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
) {
  if (!discordUserId) return ephemeral("Couldn't identify you.");
  const ok = await sendOnboardingDM(admin, discordUserId);
  if (!ok) {
    return ephemeral(
      "I tried to DM you the wizard but Discord blocked it — enable DMs from server members and try again.",
    );
  }
  return ephemeral("Sent the wizard to your DMs. Check your inbox.");
}

async function handleOnboardingClick(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
  body: any,
  customId: string,
) {
  if (!discordUserId) return ephemeral("Couldn't identify you.");
  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!profile) return ephemeral("Link your account first.");

  if (customId === "onb:intro") {
    await admin
      .from("profiles")
      .update({ discord_introduced_at: new Date().toISOString() })
      .eq("id", profile.id);
    return ephemeral("Marked step 2 done. Welcome aboard 🎉");
  }
  if (customId === "onb:rsvp-info") {
    const settings = await getDiscordSettings();
    return ephemeral(
      settings.eventsChannelId
        ? `Find upcoming events in <#${settings.eventsChannelId}> and tap "Going". I'll mark step 3 done automatically.`
        : `Run \`/events\` to see what's coming up. RSVP to any event to finish step 3.`,
    );
  }
  return ack();
}

// ===========================================================================
// /queue — office hours queue (join, leave, list, next)
// ===========================================================================

async function handleQueue(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
  body: any,
) {
  if (!discordUserId) return ephemeral("Couldn't identify you.");
  const { data: profile } = await admin
    .from("profiles")
    .select("id, role, full_name")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!profile) {
    return ephemeral(`Link your account first: ${env.siteUrl}/dashboard/settings`);
  }

  const { sub, options } = readSubCommand(body);

  if (sub === "join") {
    // Block dupes — one waiting row per user max.
    const { data: existing } = await admin
      .from("oh_queue")
      .select("id")
      .eq("user_id", profile.id)
      .eq("status", "waiting")
      .maybeSingle();
    if (existing) {
      return ephemeral("You're already in the queue. Use `/queue leave` first if you want to update your topic.");
    }
    const topic = (options.get("topic") as string | undefined)?.trim().slice(0, 240) || null;
    const { data: row, error } = await admin
      .from("oh_queue")
      .insert({ user_id: profile.id, topic, status: "waiting" })
      .select("id")
      .single();
    if (error) {
      console.error("[discord] queue join failed", error);
      return ephemeral("Couldn't join the queue. Try again.");
    }
    // Notify on-call mentors in #mentor-lounge (admin feed channel).
    const settings = await getDiscordSettings();
    if (settings.adminFeedChannelId) {
      const { data: oncall } = await admin
        .from("mentor_oncall")
        .select("mentor_id, profile:profiles(discord_user_id)")
        .limit(5);
      const mentions = (oncall ?? [])
        .map((m: any) => {
          const p = Array.isArray(m.profile) ? m.profile[0] : m.profile;
          return p?.discord_user_id ? `<@${p.discord_user_id}>` : null;
        })
        .filter(Boolean)
        .join(" ");
      await postChannelMessage(settings.adminFeedChannelId, {
        content:
          (mentions || "(no mentors on-call)") +
          `\n📣 **${profile.full_name ?? "A student"}** joined the OH queue${
            topic ? `: ${topic}` : ""
          }. Run \`/queue next\` to pull them in.`,
        allowedMentions: { parse: ["users"] },
      });
    }
    return ephemeral(`You're in the queue${topic ? ` for: ${topic}` : ""}. A mentor will ping you when it's your turn.`);
  }

  if (sub === "leave") {
    const { error } = await admin
      .from("oh_queue")
      .update({ status: "cancelled", closed_at: new Date().toISOString() })
      .eq("user_id", profile.id)
      .eq("status", "waiting");
    if (error) return ephemeral("Couldn't leave the queue.");
    return ephemeral("Removed from the queue.");
  }

  if (sub === "list") {
    const { data: rows } = await admin
      .from("oh_queue")
      .select("id, topic, joined_at, user:profiles(full_name, discord_user_id)")
      .eq("status", "waiting")
      .order("joined_at", { ascending: true })
      .limit(15);
    if (!rows || rows.length === 0) return ephemeral("Queue is empty.");
    const lines = rows.map((r: any, i: number) => {
      const u = Array.isArray(r.user) ? r.user[0] : r.user;
      const tag = u?.discord_user_id ? `<@${u.discord_user_id}>` : u?.full_name ?? "—";
      return `${i + 1}. ${tag}${r.topic ? ` · ${r.topic}` : ""}`;
    });
    return ephemeral(["**Office hours queue**", ...lines].join("\n"));
  }

  if (sub === "next") {
    if (profile.role !== "admin" && profile.role !== "mentor") {
      return ephemeral("Only mentors + admins can run `/queue next`.");
    }
    const { data: nextRow } = await admin
      .from("oh_queue")
      .select("id, topic, user:profiles(full_name, discord_user_id)")
      .eq("status", "waiting")
      .order("joined_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!nextRow) return ephemeral("Queue is empty.");
    await admin
      .from("oh_queue")
      .update({
        status: "claimed",
        claimed_by: profile.id,
        claimed_at: new Date().toISOString(),
      })
      .eq("id", (nextRow as any).id);

    const u = Array.isArray((nextRow as any).user)
      ? (nextRow as any).user[0]
      : (nextRow as any).user;
    const settings = await getDiscordSettings();
    const voiceLine = settings.ohVoiceChannelId
      ? `\nJoin the voice channel: <#${settings.ohVoiceChannelId}>`
      : "";
    // DM the student so they don't miss the call.
    if (u?.discord_user_id) {
      await sendDirectMessage(u.discord_user_id, {
        content: `Hey — **${profile.full_name ?? "a mentor"}** is ready to talk through your check-in / blocker.${voiceLine}`,
      });
    }
    return ephemeral(
      `Pulled **${u?.full_name ?? "the next caller"}**${(nextRow as any).topic ? ` (topic: ${(nextRow as any).topic})` : ""}. I DM'd them${voiceLine ? " with the voice link." : "."}`,
    );
  }

  return ephemeral("Try `/queue join`, `/queue leave`, `/queue list`, or `/queue next`.");
}

// ===========================================================================
// /oncall — mentor availability + pinned-message updater
// ===========================================================================

async function handleOncall(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
  body: any,
) {
  if (!discordUserId) return ephemeral("Couldn't identify you.");
  const { data: profile } = await admin
    .from("profiles")
    .select("id, role, full_name")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!profile) return ephemeral("Link your account first.");

  const { sub, options } = readSubCommand(body);

  if (sub === "list") {
    return await refreshOncallEphemeral(admin);
  }

  if (profile.role !== "admin" && profile.role !== "mentor") {
    return ephemeral("Only mentors + admins can flip on-call.");
  }

  if (sub === "on") {
    const note = (options.get("note") as string | undefined)?.trim().slice(0, 200) || null;
    const minutes = (options.get("minutes") as number | undefined) ?? 60;
    const expires = new Date(Date.now() + Math.max(15, minutes) * 60_000).toISOString();
    await admin.from("mentor_oncall").upsert(
      {
        mentor_id: profile.id,
        started_at: new Date().toISOString(),
        expires_at: expires,
        note,
      },
      { onConflict: "mentor_id" },
    );
    // Fire-and-forget pinned-message refresh; ack the mentor immediately.
    void refreshOncallPin(admin);
    return ephemeral(`✅ You're on-call until <t:${Math.floor(new Date(expires).getTime() / 1000)}:t>${note ? ` · _${note}_` : ""}.`);
  }

  if (sub === "off") {
    await admin.from("mentor_oncall").delete().eq("mentor_id", profile.id);
    void refreshOncallPin(admin);
    return ephemeral("✅ Marked you off-call.");
  }

  return ephemeral("Try `/oncall on`, `/oncall off`, or `/oncall list`.");
}

async function refreshOncallEphemeral(
  admin: ReturnType<typeof createAdminClient>,
) {
  const rows = await currentOncall(admin);
  if (rows.length === 0) return ephemeral("No mentors on-call right now.");
  const lines = rows.map((r) =>
    `• <@${r.discordUserId}>${r.note ? ` — ${r.note}` : ""}${r.expiresAt ? ` (until <t:${r.expiresAtEpoch}:t>)` : ""}`,
  );
  return ephemeral(["**Mentors on-call**", ...lines].join("\n"));
}

// ===========================================================================
// Message context menu: "🆘 Flag as Blocker"
// ===========================================================================

async function handleFlagBlocker(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
  body: any,
) {
  if (!discordUserId) return ephemeral("Couldn't identify you.");
  // Resolved message is at body.data.resolved.messages[<id>] keyed by
  // the target id at body.data.target_id.
  const targetId: string = body.data?.target_id ?? "";
  const message = body.data?.resolved?.messages?.[targetId];
  if (!message) return ephemeral("Couldn't read the message you flagged.");

  const channelId: string = body.channel_id ?? message.channel_id ?? "";
  const author = message.author ?? {};

  const { data: reporter } = await admin
    .from("profiles")
    .select("id, full_name")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  // Persist the blocker row.
  const { data: row, error } = await admin
    .from("team_blockers")
    .insert({
      reporter_id: reporter?.id ?? null,
      discord_channel_id: channelId || null,
      discord_message_id: targetId,
      flagged_discord_user_id: author?.id ?? null,
      flagged_display_name:
        author?.global_name ?? author?.username ?? null,
      content: (message.content ?? "").slice(0, 4000) || null,
      status: "open",
    })
    .select("id")
    .single();
  if (error) {
    console.error("[discord] flag blocker insert failed", error);
    return ephemeral("Couldn't log the blocker. Try again.");
  }

  // Open a thread on the original message so triage stays attached.
  let threadId: string | null = null;
  try {
    threadId = await startThreadFromMessage({
      channelId,
      messageId: targetId,
      name: `🆘 Blocker — ${
        author?.global_name ?? author?.username ?? "thread"
      }`.slice(0, 100),
    });
    if (threadId) {
      await admin
        .from("team_blockers")
        .update({ discord_thread_id: threadId })
        .eq("id", row!.id);

      // Mention the on-call mentors in the new thread.
      const onCall = await currentOncall(admin);
      const mentions =
        onCall
          .map((m) => (m.discordUserId ? `<@${m.discordUserId}>` : null))
          .filter(Boolean)
          .join(" ") || "";
      await postChannelMessage(threadId, {
        content:
          (mentions ? `${mentions} ` : "") +
          `Flagged by <@${discordUserId}> as a blocker. Triage here.`,
        allowedMentions: { parse: ["users"] },
      });
    }
  } catch (err) {
    console.error("[discord] open thread failed", err);
  }

  // Notify all admins in-app as well.
  try {
    const { data: admins } = await admin
      .from("profiles")
      .select("id")
      .eq("role", "admin");
    await notifyMany(
      (admins ?? []).map((a: any) => ({
        userId: a.id,
        type: "discord_blocker",
        title: `Blocker flagged in Discord`,
        body: (message.content ?? "").slice(0, 200) || "(no message body)",
        link: "/admin/interventions",
      })),
    );
  } catch {}

  return ephemeral(
    threadId
      ? `🆘 Flagged. I opened a triage thread and pinged on-call mentors.`
      : `🆘 Flagged. Couldn't open a thread (missing permission?) but admins are notified.`,
  );
}

// ===========================================================================
// Event RSVP buttons
// ===========================================================================

async function handleRsvpClick(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
  body: any,
  customId: string,
) {
  // Format: rsvp:<status>:<eventId>
  const [, status, eventId] = customId.split(":");
  if (!status || !eventId || !["going", "maybe", "declined"].includes(status)) {
    return ephemeral("Unrecognized RSVP button.");
  }
  if (!discordUserId) return ephemeral("Couldn't identify you.");

  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!profile) {
    return ephemeral(`Link your account first: ${env.siteUrl}/dashboard/settings`);
  }

  const { error } = await admin.from("event_rsvps").upsert(
    {
      event_id: eventId,
      user_id: profile.id,
      status,
      source: "discord",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "event_id,user_id" },
  );
  if (error) {
    console.error("[discord] rsvp upsert failed", error);
    return ephemeral("Couldn't save your RSVP. Try the dashboard.");
  }

  // Mark step 3 of the onboarding wizard done (first RSVP).
  await admin
    .from("profiles")
    .update({ discord_first_rsvp_at: new Date().toISOString() })
    .eq("id", profile.id)
    .is("discord_first_rsvp_at", null);

  return ephemeral(`RSVP saved: **${status}**.`);
}

// ===========================================================================
// Demo Day pitch reaction buttons (🔥 💡 🚀)
// ===========================================================================

async function handleDemoDayReact(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
  body: any,
  customId: string,
) {
  // Format: ddreact:<emoji>:<teamId>
  const [, emoji, teamId] = customId.split(":");
  if (!emoji || !teamId) return ephemeral("Bad reaction button.");

  if (!discordUserId) return ephemeral("Couldn't identify you.");
  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  // Insert a row. RLS requires user_id = auth.uid(); we're using the
  // service role here so the policy doesn't fire — the policy is for
  // direct client writes.
  const { error } = await admin.from("demo_day_reactions").insert({
    team_id: teamId,
    user_id: profile?.id ?? null,
    emoji,
  });
  if (error) {
    console.error("[discord] dd react insert failed", error);
    return ephemeral("Couldn't record your reaction.");
  }
  return ephemeral(`${emoji} added.`);
}

// ===========================================================================
// Milestone cross-post helper
// ===========================================================================

async function crosspostMilestone(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  accomplished: string,
  next_up: string,
): Promise<void> {
  try {
    const settings = await getDiscordSettings();
    if (!settings.winsChannelId) return;
    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, discord_user_id")
      .eq("id", userId)
      .maybeSingle();
    const who = profile?.discord_user_id
      ? `<@${profile.discord_user_id}>`
      : profile?.full_name ?? "A student";
    const body =
      (accomplished || next_up || "Big milestone hit.").slice(0, 1500);
    await postChannelMessage(settings.winsChannelId, {
      content: `🎉 **${who}** just hit a milestone:\n${body}`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error("[discord] milestone crosspost failed", err);
  }
}
