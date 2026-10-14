import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { DiscordConfigForm } from "./config-form";
import { EnableToggle } from "./enable-toggle";
import { OpsPanel } from "./ops-panel";
import { BootstrapPanel } from "./bootstrap-panel";
import { AdminMyDiscordLinkCard } from "./my-link-card";
import { AutoQuestionsPanel } from "./auto-questions-panel";
import { HealthCheck } from "./health-check";
import { automaticQuestionSnapshot } from "@/lib/discord-auto-runtime";
import { requireUser } from "@/lib/auth";
import { isDiscordEnabled, SLASH_COMMANDS } from "@/lib/discord";
import { env } from "@/lib/env";
import type { DiscordConfigInput } from "./actions";

export const metadata = { title: "Discord · Admin" };

// Bootstrap fires ~40 sequential Discord API calls with ~350ms throttle.
// Comfortably under 300s but well above the 60s default — bump it.
export const maxDuration = 300;

const KEYS_TO_FIELD = {
  discord_channel_announcements_id: "announcementsChannelId",
  discord_channel_events_id: "eventsChannelId",
  discord_channel_admin_feed_id: "adminFeedChannelId",
  discord_channel_teams_category_id: "teamsCategoryId",
  discord_channel_help_id: "helpChannelId",
  discord_channel_oh_voice_id: "ohVoiceChannelId",
  discord_channel_introductions_id: "introductionsChannelId",
  discord_role_student_id: "roleStudentId",
  discord_role_mentor_id: "roleMentorId",
  discord_role_admin_id: "roleAdminId",
  discord_role_investor_id: "roleInvestorId",
  discord_role_founder_pass_id: "roleFounderPassId",
} as const;

// Database reads only. Anything that calls Discord (health check, stats)
// waits for "Run check", so the page stays fast and off the rate limit.
export default async function AdminDiscordPage() {
  const admin = createAdminClient();
  const user = await requireUser();
  const [
    { data: rows },
    enabled,
    { data: meRow },
    { data: recentActivity },
    autoQuestions,
  ] = await Promise.all([
    admin
      .from("site_settings")
      .select("key, value")
      .in("key", Object.keys(KEYS_TO_FIELD)),
    isDiscordEnabled(),
    admin
      .from("profiles")
      .select("discord_user_id, discord_username, discord_linked_at")
      .eq("id", user.id)
      .maybeSingle(),
    admin
      .from("audit_log")
      .select("id, action, created_at, actor_email")
      .like("action", "discord.%")
      .order("created_at", { ascending: false })
      .limit(10),
    automaticQuestionSnapshot(),
  ]);

  const initial: DiscordConfigInput = {
    announcementsChannelId: "",
    eventsChannelId: "",
    adminFeedChannelId: "",
    teamsCategoryId: "",
    helpChannelId: "",
    ohVoiceChannelId: "",
    introductionsChannelId: "",
    roleStudentId: "",
    roleMentorId: "",
    roleAdminId: "",
    roleInvestorId: "",
    roleFounderPassId: "",
  };
  for (const r of rows ?? []) {
    const field = (KEYS_TO_FIELD as any)[r.key] as keyof DiscordConfigInput;
    if (!field) continue;
    initial[field] = typeof r.value === "string" ? r.value : "";
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Discord</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Account linking, role sync, cross-posts and slash commands.
      </p>

      <div className="mt-6">
        <EnableToggle initial={enabled} />
      </div>

      <Card className="mt-6">
        <HealthCheck />
      </Card>

      <AutoQuestionsPanel initial={autoQuestions} />

      <div className="mt-6">
        <AdminMyDiscordLinkCard
          profile={{
            discord_user_id: (meRow as any)?.discord_user_id ?? null,
            discord_username: (meRow as any)?.discord_username ?? null,
            discord_linked_at: (meRow as any)?.discord_linked_at ?? null,
          }}
        />
      </div>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Operations
        </h2>
        <div className="mt-4">
          <OpsPanel />
        </div>
      </Card>

      <Card className="mt-6">
        <DiscordConfigForm initial={initial} />
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Bootstrap server from scratch
        </h2>
        <p className="mt-1 text-xs text-ink-faint">
          Deletes every channel and role, then rebuilds the batch0 layout.
        </p>
        <div className="mt-4">
          <BootstrapPanel />
        </div>
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Slash commands
        </h2>
        <p className="mt-2 text-xs text-ink-faint">
          Interactions endpoint
        </p>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-wash p-3 text-xs text-phosphor-ink">
          {env.siteUrl}/api/discord/interactions
        </pre>
        <ul className="mt-3 grid gap-1.5 text-sm text-ink-soft sm:grid-cols-2">
          {SLASH_COMMANDS.map((c) => {
            // type 3 = MESSAGE context menu — appears under "right-click →
            // Apps", not as a slash command, so render the difference.
            const isContextMenu = (c as any).type === 3;
            return (
              <li
                key={c.name}
                className="rounded-lg border border-line bg-wash px-3 py-2"
              >
                <code className="text-phosphor-ink">
                  {isContextMenu ? "≡ " : "/"}{c.name}
                </code>
                <p className="mt-0.5 text-xs text-ink-faint">
                  {(c as any).description ??
                    (isContextMenu
                      ? "Right-click on a message → Apps."
                      : "")}
                </p>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-ink-faint">
          After a deploy that changes this list, press{" "}
          <strong>Register slash commands</strong> above.
        </p>
      </Card>

      {(recentActivity?.length ?? 0) > 0 && (
        <Card className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
            Recent Discord activity
          </h2>
          <ul className="mt-3 divide-y divide-line text-sm">
            {(recentActivity ?? []).map((a: any) => (
              <li key={a.id} className="flex items-baseline justify-between gap-4 py-2">
                <span className="font-mono text-xs text-phosphor-ink">
                  {a.action.replace(/^discord\./, "")}
                </span>
                <span className="truncate text-xs text-ink-faint">
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
