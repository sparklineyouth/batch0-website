import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { DiscordConfigForm } from "./config-form";
import { EnableToggle } from "./enable-toggle";
import { OpsPanel } from "./ops-panel";
import {
  isDiscordEnabled,
  listRegisteredCommands,
  fetchGuildMemberCount,
  SLASH_COMMANDS,
} from "@/lib/discord";
import { env } from "@/lib/env";
import type { DiscordConfigInput } from "./actions";
import type { Role } from "@/lib/types";

export const metadata = { title: "Discord · Admin" };

const KEYS_TO_FIELD = {
  discord_channel_announcements_id: "announcementsChannelId",
  discord_channel_events_id: "eventsChannelId",
  discord_channel_admin_feed_id: "adminFeedChannelId",
  discord_role_student_id: "roleStudentId",
  discord_role_mentor_id: "roleMentorId",
  discord_role_admin_id: "roleAdminId",
  discord_role_investor_id: "roleInvestorId",
} as const;

export default async function AdminDiscordPage() {
  const admin = createAdminClient();
  const [{ data: rows }, enabled, registered, memberCount] = await Promise.all([
    admin
      .from("site_settings")
      .select("key, value")
      .in("key", Object.keys(KEYS_TO_FIELD)),
    isDiscordEnabled(),
    listRegisteredCommands(),
    fetchGuildMemberCount(),
  ]);

  const initial: DiscordConfigInput = {
    announcementsChannelId: "",
    eventsChannelId: "",
    adminFeedChannelId: "",
    roleStudentId: "",
    roleMentorId: "",
    roleAdminId: "",
    roleInvestorId: "",
  };
  for (const r of rows ?? []) {
    const field = (KEYS_TO_FIELD as any)[r.key] as keyof DiscordConfigInput;
    if (!field) continue;
    initial[field] = typeof r.value === "string" ? r.value : "";
  }

  // Linked-account stats. 0008 may not be applied yet, so swallow that
  // case and fall back to zeros.
  let linkedCount = 0;
  let enrolledCount = 0;
  let enrolledLinkedCount = 0;
  const byRole: Partial<Record<Role, number>> = {};
  try {
    const { data: linkedRows } = await admin
      .from("profiles")
      .select("id, role")
      .not("discord_user_id", "is", null);
    linkedCount = linkedRows?.length ?? 0;
    for (const r of linkedRows ?? []) {
      const role = ((r as any).role as Role) ?? "student";
      byRole[role] = (byRole[role] ?? 0) + 1;
    }

    const linkedIds = new Set((linkedRows ?? []).map((r: any) => r.id));
    const { data: enrollments } = await admin
      .from("enrollments")
      .select("user_id");
    enrolledCount = enrollments?.length ?? 0;
    enrolledLinkedCount = (enrollments ?? []).filter((e: any) =>
      linkedIds.has(e.user_id),
    ).length;
  } catch {
    // ignore — column doesn't exist yet
  }

  // Recent discord.* audit entries — the activity feed for the page.
  let recentActivity: { id: string; action: string; created_at: string; actor_email: string | null }[] = [];
  try {
    const { data } = await admin
      .from("audit_log")
      .select("id, action, created_at, actor_email")
      .like("action", "discord.%")
      .order("created_at", { ascending: false })
      .limit(10);
    recentActivity = (data as any) ?? [];
  } catch {
    // audit_log query is harmless even if empty
  }

  const hasBot = Boolean(env.discordBotToken);
  const hasOauth = Boolean(env.discordClientId && env.discordClientSecret);
  const hasInteractions = Boolean(env.discordPublicKey);
  const guildId = env.discordGuildId;

  const registeredNames = registered?.map((c) => c.name) ?? null;
  const specNames = SLASH_COMMANDS.map((c) => c.name);
  const missingFromDiscord = specNames.filter(
    (n) => registeredNames && !registeredNames.includes(n),
  );

  const linkRate =
    enrolledCount > 0
      ? Math.round((enrolledLinkedCount / enrolledCount) * 100)
      : null;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Discord</h1>
      <p className="mt-1 text-sm text-white/55">
        Wire SparkLine Youth into your Discord server. Account linking, role sync,
        cross-posts, and slash commands run off of this configuration.
      </p>

      <div className="mt-6">
        <EnableToggle initial={enabled} />
      </div>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
          Connection status
        </h2>
        <ul className="mt-4 space-y-2 text-sm">
          <Status
            ok={hasBot}
            label="Bot token (DISCORD_BOT_TOKEN)"
            hint={hasBot ? "Loaded from env." : "Missing — set in Vercel env."}
          />
          <Status
            ok={Boolean(guildId)}
            label="Guild ID (DISCORD_GUILD_ID)"
            hint={guildId ? `Guild ${guildId}` : "Missing — set in Vercel env."}
          />
          <Status
            ok={hasOauth}
            label="OAuth (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET)"
            hint={
              hasOauth
                ? "Account-linking enabled."
                : "Without these, users can't link Discord accounts."
            }
          />
          <Status
            ok={hasInteractions}
            label="Slash commands (DISCORD_PUBLIC_KEY)"
            hint={
              hasInteractions
                ? `Endpoint: ${env.siteUrl}/api/discord/interactions`
                : "Set the Public Key from the Discord developer portal to enable interactions."
            }
          />
          <Status
            ok={
              registeredNames !== null &&
              missingFromDiscord.length === 0 &&
              registeredNames.length > 0
            }
            label="Slash commands registered with Discord"
            hint={
              registeredNames === null
                ? "Couldn't query Discord — check the bot token."
                : registeredNames.length === 0
                  ? "No commands live yet. Use the Operations panel below."
                  : missingFromDiscord.length === 0
                    ? `All ${registeredNames.length} commands match the spec.`
                    : `Out of sync — missing: /${missingFromDiscord.join(", /")}`
            }
          />
        </ul>
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
          At a glance
        </h2>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Linked accounts" value={String(linkedCount)} />
          <Stat
            label="Enrolled · linked"
            value={
              linkRate == null
                ? "—"
                : `${enrolledLinkedCount}/${enrolledCount} (${linkRate}%)`
            }
          />
          <Stat
            label="Guild members"
            value={memberCount == null ? "—" : String(memberCount)}
          />
          <Stat
            label="By role"
            value={
              [
                ["student", "S"],
                ["mentor", "M"],
                ["admin", "A"],
                ["investor", "I"],
              ]
                .map(([k, abbr]) => `${abbr}:${byRole[k as Role] ?? 0}`)
                .join(" · ")
            }
          />
        </div>
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
          Operations
        </h2>
        <p className="mt-1 text-xs text-white/50">
          Register commands after editing the spec, then re-sync roles or refresh
          stored usernames as needed.
        </p>
        <div className="mt-4">
          <OpsPanel registeredNames={registeredNames} />
        </div>
      </Card>

      <Card className="mt-6">
        <DiscordConfigForm initial={initial} />
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
          Slash commands
        </h2>
        <p className="mt-2 text-sm text-white/60">
          Set the interactions endpoint URL in your Discord application to:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 p-3 text-xs text-spark">
          {env.siteUrl}/api/discord/interactions
        </pre>
        <p className="mt-3 text-sm text-white/60">Built-in commands:</p>
        <ul className="mt-2 grid gap-1.5 text-sm text-white/75 sm:grid-cols-2">
          {SLASH_COMMANDS.map((c) => (
            <li
              key={c.name}
              className="rounded-lg border border-white/10 bg-black/30 px-3 py-2"
            >
              <code className="text-spark">/{c.name}</code>
              <p className="mt-0.5 text-xs text-white/55">{c.description}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-white/45">
          Editing the list lives in <code>SLASH_COMMANDS</code> in{" "}
          <code>lib/discord.ts</code>. Click <strong>Register slash commands</strong>{" "}
          above after changes — Discord propagates global commands within an hour
          on a fresh app and instantly after that.
        </p>
      </Card>

      {recentActivity.length > 0 && (
        <Card className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
            Recent Discord activity
          </h2>
          <ul className="mt-3 divide-y divide-white/5 text-sm">
            {recentActivity.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-4 py-2">
                <span className="font-mono text-xs text-spark">
                  {a.action.replace(/^discord\./, "")}
                </span>
                <span className="truncate text-xs text-white/45">
                  {a.actor_email ?? "system"} · <LocalTime value={a.created_at} mode="datetime" />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-3">
      <p className="text-[10px] uppercase tracking-wider text-white/45">{label}</p>
      <p className="mt-1 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function Status({
  ok,
  label,
  hint,
}: {
  ok: boolean;
  label: string;
  hint: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={`mt-1 inline-block h-2 w-2 rounded-full ${
          ok ? "bg-emerald-400" : "bg-amber-400"
        }`}
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-white">{label}</p>
        <p className="text-xs text-white/50">{hint}</p>
      </div>
    </li>
  );
}
