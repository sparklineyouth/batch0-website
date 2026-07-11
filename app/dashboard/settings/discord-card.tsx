import Image from "next/image";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { discordAvatarUrl } from "@/lib/discord";
import { CheckCircle2, AlertCircle } from "lucide-react";

const DISCORD_ICON =
  "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20width%3D%2218%22%20height%3D%2218%22%20fill%3D%22%235865F2%22%3E%3Cpath%20d%3D%22M20.317%204.37a19.79%2019.79%200%200%200-4.885-1.515.074.074%200%200%200-.079.037c-.21.375-.444.864-.608%201.25a18.27%2018.27%200%200%200-5.487%200%2012.51%2012.51%200%200%200-.617-1.25.077.077%200%200%200-.079-.037A19.74%2019.74%200%200%200%203.677%204.37a.07.07%200%200%200-.032.027C.533%209.046-.32%2013.58.099%2018.057a.082.082%200%200%200%20.031.057%2019.9%2019.9%200%200%200%205.993%203.03.078.078%200%200%200%20.084-.028c.462-.63.874-1.295%201.226-1.994.021-.041.001-.09-.041-.106a13.107%2013.107%200%200%201-1.872-.892.077.077%200%200%201-.008-.128%2010.2%2010.2%200%200%200%20.372-.292.074.074%200%200%201%20.077-.01c3.927%201.793%208.18%201.793%2012.062%200a.074.074%200%200%201%20.078.01c.12.098.246.198.373.292a.077.077%200%200%201-.006.127c-.598.349-1.22.645-1.873.891a.077.077%200%200%200-.041.107c.36.698.772%201.362%201.225%201.993a.076.076%200%200%200%20.084.028%2019.84%2019.84%200%200%200%206.002-3.03.077.077%200%200%200%20.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061%200%200%200-.031-.03zM8.02%2015.331c-1.182%200-2.157-1.085-2.157-2.419%200-1.333.956-2.418%202.157-2.418%201.21%200%202.176%201.095%202.157%202.418%200%201.334-.956%202.42-2.157%202.42zm7.974%200c-1.183%200-2.157-1.085-2.157-2.419%200-1.333.955-2.418%202.157-2.418%201.21%200%202.176%201.095%202.157%202.418%200%201.334-.946%202.42-2.157%202.42z%22%2F%3E%3C%2Fsvg%3E";

export function DiscordCard({
  profile,
  discordInvite,
}: {
  profile: {
    discord_user_id: string | null;
    discord_username: string | null;
    discord_avatar: string | null;
    discord_linked_at: string | null;
  };
  discordInvite: string | null;
}) {
  const linked = Boolean(profile.discord_user_id);
  const avatar = discordAvatarUrl(
    profile.discord_user_id,
    profile.discord_avatar,
    64,
  );

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Image src={DISCORD_ICON} alt="" width={20} height={20} unoptimized />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
            Discord
          </h2>
        </div>
        {linked ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-200">
            <CheckCircle2 className="h-3 w-3" /> Linked
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/55">
            <AlertCircle className="h-3 w-3" /> Not linked
          </span>
        )}
      </div>

      {linked ? (
        <>
          <div className="mt-5 flex items-center gap-3 rounded-xl border border-white/10 bg-black/30 p-3">
            {avatar ? (
              <Image
                src={avatar}
                alt=""
                width={40}
                height={40}
                className="rounded-full"
                unoptimized
              />
            ) : (
              <div className="h-10 w-10 rounded-full bg-white/10" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">
                @{profile.discord_username ?? "discord-user"}
              </p>
              <p className="truncate text-xs text-white/45">
                Linked <LocalTime value={profile.discord_linked_at} mode="date" fallback="" />
              </p>
            </div>
          </div>
          <p className="mt-4 text-xs text-white/55">
            We auto-assign your Sparkline Youth role in the Discord server. Use{" "}
            <code className="rounded bg-white/5 px-1 py-0.5 text-[11px] text-white/80">
              /me
            </code>{" "}
            in any channel to check your status.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {discordInvite && (
              <a href={discordInvite} target="_blank" rel="noopener noreferrer">
                <Button variant="secondary" size="sm">
                  Open the server →
                </Button>
              </a>
            )}
            <form action="/auth/discord/unlink" method="post">
              <Button variant="ghost" size="sm" type="submit">
                Unlink
              </Button>
            </form>
          </div>
        </>
      ) : (
        <>
          <p className="mt-4 text-sm text-white/65">
            Link your Discord account to join the Sparkline Youth community server.
            We'll auto-assign you a role, drop you into the right channels, and
            keep your role in sync with your status on the website.
          </p>
          <div className="mt-5">
            <a href="/auth/discord/start">
              <Button>Link Discord →</Button>
            </a>
          </div>
        </>
      )}
    </Card>
  );
}
