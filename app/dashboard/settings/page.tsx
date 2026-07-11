import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isDiscordEnabled } from "@/lib/discord";
import { SettingsForm } from "./settings-form";
import { ThemeToggle } from "./theme-toggle";
import { DiscordCard } from "./discord-card";
import { Card } from "@/components/ui/card";
import type { Theme } from "@/lib/types";

export const metadata = { title: "Settings · Sparkline Youth" };

const ERROR_COPY: Record<string, string> = {
  not_configured: "Discord isn't configured on this site yet.",
  disabled: "The Discord integration is currently paused.",
  bad_state: "Link expired or was tampered with — please retry.",
  not_signed_in: "Your session changed mid-flow — please retry.",
  oauth_failed: "Discord rejected the login. Please retry.",
  save_failed: "We couldn't save the link. Try again.",
  already_linked_to_another_account:
    "That Discord account is already linked to a different Sparkline Youth user.",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { discord?: string; discord_error?: string };
}) {
  const user = await requireUser();
  const supabase = createClient();
  const [{ data: profile }, { data: settingRows }, discordEnabled] =
    await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).single(),
      supabase
        .from("site_settings")
        .select("key, value")
        .in("key", ["discord_url"]),
      isDiscordEnabled(),
    ]);

  const theme: Theme = profile?.theme === "light" ? "light" : "dark";
  const discordInvite =
    (settingRows ?? []).find((s: any) => s.key === "discord_url")?.value || null;

  const linkedJustNow = searchParams.discord === "linked";
  const unlinkedJustNow = searchParams.discord === "unlinked";
  const error = searchParams.discord_error
    ? ERROR_COPY[searchParams.discord_error] ?? searchParams.discord_error
    : null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Update your profile, preferences, and account.
      </p>

      {(linkedJustNow || unlinkedJustNow) && (
        <div className="mt-5 rounded-lg border border-spark/30 bg-spark/5 p-3 text-sm text-spark-ink">
          {linkedJustNow
            ? "Discord linked. Welcome to the community."
            : "Discord unlinked."}
        </div>
      )}
      {error && (
        <div className="mt-5 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <Card className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Appearance
        </h2>
        <p className="mb-4 text-sm text-ink-soft">
          Switch between light and dark mode. Applies across your dashboard
          on every device you sign in to.
        </p>
        <ThemeToggle initial={theme} />
      </Card>

      {discordEnabled && (
        <div className="mt-6">
          <DiscordCard
            profile={{
              discord_user_id: profile?.discord_user_id ?? null,
              discord_username: profile?.discord_username ?? null,
              discord_avatar: profile?.discord_avatar ?? null,
              discord_linked_at: profile?.discord_linked_at ?? null,
            }}
            discordInvite={discordInvite}
          />
        </div>
      )}

      <Card className="mt-6">
        <SettingsForm
          initialFullName={profile?.full_name ?? ""}
          email={user.email ?? ""}
        />
      </Card>
    </div>
  );
}
