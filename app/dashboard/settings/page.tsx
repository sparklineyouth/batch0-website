import { requireUser, getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isDiscordEnabled } from "@/lib/discord";
import { SettingsForm } from "./settings-form";
import { ThemeToggle } from "./theme-toggle";
import { DiscordCard } from "./discord-card";
import { Card } from "@/components/ui/card";
import type { Theme } from "@/lib/types";

export const metadata = { title: "Settings · batch0" };

// Every `?discord_error=` code any of the /auth/discord/* routes can redirect
// with. An unknown code falls through to the raw string rather than being
// dropped — a slightly technical message still beats a banner that silently
// says nothing, which is what a missing key used to produce.
const ERROR_COPY: Record<string, string> = {
  not_configured: "Discord isn't configured on this site yet.",
  disabled: "The Discord integration is currently paused.",
  bad_state: "Link expired or was tampered with — please retry.",
  not_signed_in: "Your session changed mid-flow — please retry.",
  oauth_failed: "Discord rejected the login. Please retry.",
  save_failed: "We couldn't save the link. Try again.",
  already_linked_to_another_account:
    "That Discord account is already linked to a different batch0 user.",
  unlink_failed:
    "We couldn't unlink your Discord account. Nothing changed — try again, and tell us if it keeps failing.",
};

// `?discord=` — the success side. `unlinked_partial` is a real outcome, not a
// hedge: the profile columns are cleared (so the unlink *did* happen and the
// banner is not an error), but Discord wouldn't confirm the role removals.
//
// The copy says the roles may still be there rather than "they'll clear
// shortly", because nothing clears them. `resyncAllRoles()` in
// app/admin/discord/actions.ts only walks profiles that still HAVE a
// discord_user_id, and this one no longer does — so the leftover roles are
// invisible to every automated path we have. The audit row carries
// `roles_revoked: false` for staff; this sentence is what the user can act on.
const STATUS_COPY: Record<string, string> = {
  linked: "Discord linked. Welcome to the community.",
  unlinked: "Discord unlinked.",
  unlinked_partial:
    "Discord unlinked here, but we couldn't reach Discord to take your batch0 roles off your account — they may still show in the server. Leaving the server clears them, or email hello@batch0.org and we'll do it.",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { discord?: string; discord_error?: string };
}) {
  const user = await requireUser();
  const supabase = createClient();
  // Profile comes from the request-cached getProfile() the layout already
  // resolved — it carries every column this page reads.
  const [profile, { data: settingRows }, discordEnabled] = await Promise.all([
    getProfile(),
    supabase
      .from("site_settings")
      .select("key, value")
      .in("key", ["discord_url"]),
    isDiscordEnabled(),
  ]);

  const theme: Theme = profile?.theme === "light" ? "light" : "dark";
  const discordInvite =
    (settingRows ?? []).find((s: any) => s.key === "discord_url")?.value || null;

  const status = searchParams.discord
    ? STATUS_COPY[searchParams.discord] ?? null
    : null;
  const error = searchParams.discord_error
    ? ERROR_COPY[searchParams.discord_error] ?? searchParams.discord_error
    : null;

  // The card is shown when the integration is on, OR when it's off but this
  // person is still linked. Hiding it outright in the second case left them
  // holding a link they could see referenced elsewhere and had no way to
  // remove; the card renders in a paused state instead (see DiscordCard).
  const linked = Boolean(profile?.discord_user_id);
  const showDiscordCard = discordEnabled || linked;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Update your profile, preferences, and account.
      </p>

      {status && (
        <div
          role="status"
          className="mt-5 rounded-lg border border-phosphor/30 bg-phosphor/5 p-3 text-sm text-phosphor-ink"
        >
          {status}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mt-5 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300"
        >
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

      {showDiscordCard && (
        <div className="mt-6">
          <DiscordCard
            profile={{
              discord_user_id: profile?.discord_user_id ?? null,
              discord_username: profile?.discord_username ?? null,
              discord_avatar: profile?.discord_avatar ?? null,
              discord_linked_at: profile?.discord_linked_at ?? null,
            }}
            discordInvite={discordInvite}
            enabled={discordEnabled}
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
