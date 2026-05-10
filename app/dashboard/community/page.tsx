import Link from "next/link";
import Image from "next/image";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { discordAvatarUrl } from "@/lib/discord";

export const metadata = { title: "Community · SparkLine" };

export default async function CommunityPage() {
  const user = await requireUser();
  const supabase = createClient();
  const [{ data: profile }, { data: settings }, { data: announcements }] =
    await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).single(),
      supabase
        .from("site_settings")
        .select("key, value")
        .eq("key", "discord_url"),
      supabase
        .from("notifications")
        .select("id, title, body, link, created_at")
        .eq("user_id", user.id)
        .eq("type", "announcement")
        .order("created_at", { ascending: false })
        .limit(10),
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
      <p className="mt-1 text-sm text-white/55">
        The SparkLine Discord server is where every cohort lives: workshops,
        peer reviews, demo-day prep, post-grad alumni. Link your account once
        and we keep your role in sync forever.
      </p>

      <Card className="mt-8 overflow-hidden border-[#5865F2]/20">
        <div
          aria-hidden
          className="-mx-6 -mt-6 mb-5 h-1.5 bg-[#5865F2]"
        />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Discord access</h2>
            <p className="mt-1 text-sm text-white/55">
              {linked
                ? "Your account is linked. Use /me in the server to check status anytime."
                : "Link to get the right role, the right channels, and a server invite."}
            </p>
          </div>
          {linked && avatar ? (
            <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/30 px-3 py-2">
              <Image
                src={avatar}
                alt=""
                width={36}
                height={36}
                className="rounded-full"
                unoptimized
              />
              <div>
                <p className="text-sm font-medium text-white">
                  @{profile?.discord_username ?? "discord"}
                </p>
                <p className="text-xs text-white/50">Linked</p>
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
            <Link href="/auth/discord/start">
              <Button>Link Discord →</Button>
            </Link>
          )}
          <Link href="/dashboard/settings">
            <Button variant="ghost">Settings</Button>
          </Link>
        </div>
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
          Slash commands
        </h2>
        <p className="mt-2 text-sm text-white/60">
          Anyone in the server can run these. Replies are private — only you
          see them.
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          <Cmd cmd="/me" desc="Your application + cohort + open charges." />
          <Cmd cmd="/cohort" desc="Cohort summary." />
          <Cmd cmd="/link" desc="DM yourself the account-link URL." />
          <Cmd cmd="/announce" desc="Admins only — broadcast." />
        </ul>
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
          Recent announcements
        </h2>
        {(announcements?.length ?? 0) === 0 ? (
          <p className="mt-3 text-sm text-white/55">
            Nothing yet. Announcements posted by admins (here or from Discord
            with <code className="text-spark">/announce</code>) will show up
            here.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-white/5">
            {(announcements ?? []).map((n: any) => (
              <li key={n.id} className="py-3">
                <p className="text-sm font-medium text-white">{n.title}</p>
                {n.body && (
                  <p className="mt-0.5 text-sm text-white/65">{n.body}</p>
                )}
                <p className="mt-1 text-xs text-white/40">
                  {new Date(n.created_at).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Cmd({ cmd, desc }: { cmd: string; desc: string }) {
  return (
    <li className="rounded-xl border border-white/10 bg-black/30 p-3">
      <code className="text-sm font-semibold text-spark">{cmd}</code>
      <p className="mt-1 text-xs text-white/55">{desc}</p>
    </li>
  );
}
