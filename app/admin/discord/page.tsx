import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { DiscordConfigForm } from "./config-form";
import { env } from "@/lib/env";
import type { DiscordConfigInput } from "./actions";

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
  const { data: rows } = await admin
    .from("site_settings")
    .select("key, value")
    .in("key", Object.keys(KEYS_TO_FIELD));

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

  const { data: linkedCount } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .not("discord_user_id", "is", null);

  const hasBot = Boolean(env.discordBotToken);
  const hasOauth = Boolean(env.discordClientId && env.discordClientSecret);
  const hasInteractions = Boolean(env.discordPublicKey);
  const guildId = env.discordGuildId;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Discord</h1>
      <p className="mt-1 text-sm text-white/55">
        Wire SparkLine into your Discord server. Account linking, role sync,
        cross-posts, and slash commands run off of this configuration.
      </p>

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
        </ul>
        <p className="mt-5 text-xs text-white/45">
          Linked accounts: <span className="text-white/80">{(linkedCount as any) ?? 0}</span>
        </p>
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
        <p className="mt-3 text-sm text-white/60">Register these commands:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-white/75">
          <li>
            <code className="rounded bg-white/5 px-1 text-spark">/me</code> — show
            the caller's SparkLine status (ephemeral).
          </li>
          <li>
            <code className="rounded bg-white/5 px-1 text-spark">/link</code> —
            DM the link URL to connect their account.
          </li>
          <li>
            <code className="rounded bg-white/5 px-1 text-spark">/cohort</code> —
            show the caller's current cohort.
          </li>
          <li>
            <code className="rounded bg-white/5 px-1 text-spark">
              /announce title:&lt;…&gt; message:&lt;…&gt;
            </code>{" "}
            — admins only, posts to the announcements channel + mirrors as an
            in-app notification.
          </li>
        </ul>
        <p className="mt-3 text-xs text-white/45">
          Use the Discord API or a helper script to register the commands
          against your application ID once.
        </p>
      </Card>
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
