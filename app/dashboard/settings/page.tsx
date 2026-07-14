import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isDiscordEnabled } from "@/lib/discord";
import { SettingsForm } from "./settings-form";
import { DiscordCard } from "./discord-card";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Settings · batch0" };

const ERROR_COPY: Record<string, string> = {
  not_configured: "Discord isn't configured on this site yet.",
  disabled: "The Discord integration is currently paused.",
  bad_state: "Link expired or was tampered with — please retry.",
  not_signed_in: "Your session changed mid-flow — please retry.",
  oauth_failed: "Discord rejected the login. Please retry.",
  save_failed: "We couldn't save the link. Try again.",
  already_linked_to_another_account:
    "That Discord account is already linked to a different batch0 user.",
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
        <div className="mt-5 rounded-lg border border-phosphor/30 bg-phosphor/5 p-3 text-sm text-phosphor-ink">
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

      {discordEnabled && (
        <div className="mt-8">
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
