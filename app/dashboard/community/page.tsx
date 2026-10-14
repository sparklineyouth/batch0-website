import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Button, ButtonLink } from "@/components/ui/button";
import { discordAvatarUrl, isDiscordEnabled } from "@/lib/discord";

export const metadata = { title: "Community · batch0" };

export default async function CommunityPage() {
  await requireUser();
  if (!(await isDiscordEnabled())) redirect("/dashboard");
  const supabase = await createClient();
  // Profile comes from the request-cached getProfile() the layout already
  // resolved — it carries the discord_* columns this page reads.
  const [profile, { data: settings }] =
    await Promise.all([
      getProfile(),
      supabase
        .from("site_settings")
        .select("key, value")
        .eq("key", "discord_url"),
    ]);

  const inviteUrl =
    (settings ?? []).find((r: any) => r.key === "discord_url")?.value || null;
  const linked = Boolean(profile?.discord_user_id);
  const avatar = discordAvatarUrl(
    profile?.discord_user_id ?? null,
    profile?.discord_avatar ?? null,
    64,
  );

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-bold tracking-tight">Community</h1>
      <p className="mt-1 text-sm text-ink-soft">
        The batch0 Discord. Link once; your role syncs.
      </p>

      <Card className="mt-8 overflow-hidden border-[#5865F2]/20">
        <div
          aria-hidden
          className="-mx-6 -mt-6 mb-5 h-1.5 bg-[#5865F2]"
        />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Discord access</h2>
            <p className="mt-1 text-sm text-ink-soft">
              {linked
                ? "Linked. Check your status with /me."
                : "Link to get your role and an invite."}
            </p>
          </div>
          {linked && avatar ? (
            <div className="flex items-center gap-3 rounded-xl border border-line bg-paper px-3 py-2">
              <Image
                src={avatar}
                alt=""
                width={36}
                height={36}
                className="rounded-full"
                unoptimized
              />
              <div>
                <p className="text-sm font-medium text-ink">
                  @{profile?.discord_username ?? "discord"}
                </p>
                <p className="text-xs text-ink-faint">Linked</p>
              </div>
            </div>
          ) : null}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {linked ? (
            inviteUrl && (
              <a href={inviteUrl} target="_blank" rel="noopener noreferrer">
                <Button>Open the server →</Button>
              </a>
            )
          ) : (
            <ButtonLink href="/auth/discord/start">Link Discord →</ButtonLink>
          )}
          <ButtonLink href="/dashboard/settings" variant="ghost">
            Settings
          </ButtonLink>
        </div>
      </Card>

      <p className="mt-6 text-sm text-ink-soft">
        Private question for the team?{" "}
        <Link
          href="/dashboard/support/new?topic=program&source=community"
          prefetch={false}
          className="link-ink"
        >
          Contact support
        </Link>
      </p>
    </div>
  );
}
