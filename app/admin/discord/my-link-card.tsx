import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { CheckCircle2, AlertCircle } from "lucide-react";

/**
 * Lets the admin link their own Discord account from /admin/discord
 * instead of bouncing through /dashboard/settings. Reuses the exact
 * same /auth/discord/start flow — there's no admin-specific path.
 */
export function AdminMyDiscordLinkCard({
  profile,
}: {
  profile: {
    discord_user_id: string | null;
    discord_username: string | null;
    discord_linked_at: string | null;
  };
}) {
  const linked = Boolean(profile.discord_user_id);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
            Your Discord link
          </h2>
          <p className="mt-1 text-xs text-white/50">
            Link your own account so <code>/whois</code>, <code>/announce</code>,
            and the admin role auto-sync work for you.
          </p>
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
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-white/80">
            @{profile.discord_username ?? profile.discord_user_id}
          </span>
          <span className="text-xs text-white/45">
            Linked{" "}
            <LocalTime value={profile.discord_linked_at} mode="date" fallback="" />
          </span>
          <form action="/auth/discord/unlink" method="post" className="ml-auto">
            <Button variant="ghost" size="sm" type="submit">
              Unlink
            </Button>
          </form>
        </div>
      ) : (
        <div className="mt-4">
          <a href="/auth/discord/start">
            <Button>Link Discord →</Button>
          </a>
        </div>
      )}
    </Card>
  );
}
