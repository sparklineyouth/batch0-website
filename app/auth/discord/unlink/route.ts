import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  kickFromGuild,
  removeRoleFromMember,
  getDiscordSettings,
  postChannelMessage,
  announcementEmbed,
} from "@/lib/discord";
import { logAudit } from "@/lib/audit";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Drops the Discord link off the user's profile and revokes any
 * batch0-managed roles they had. Doesn't kick them from the
 * server — staff might still want them around.
 */
export async function POST() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("discord_user_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.discord_user_id) {
    return NextResponse.json({ ok: true });
  }

  if (env.discordBotToken && env.discordGuildId) {
    const settings = await getDiscordSettings();
    for (const rid of Object.values(settings.roleIdByRole)) {
      if (rid) await removeRoleFromMember(profile.discord_user_id, rid);
    }
    if (settings.adminFeedChannelId) {
      const { data: p } = await admin
        .from("profiles")
        .select("full_name, email")
        .eq("id", user.id)
        .maybeSingle();
      await postChannelMessage(settings.adminFeedChannelId, {
        embeds: [
          announcementEmbed({
            title: `🔌 Unlinked: ${p?.full_name ?? p?.email ?? "user"}`,
            body: `Removed batch0-managed roles from <@${profile.discord_user_id}>.`,
          }),
        ],
      });
    }
  }

  await admin
    .from("profiles")
    .update({
      discord_user_id: null,
      discord_username: null,
      discord_avatar: null,
      discord_linked_at: null,
    })
    .eq("id", user.id);

  await logAudit({
    action: "discord.unlinked",
    targetType: "profile",
    targetId: user.id,
    payload: { discord_user_id: profile.discord_user_id },
  });

  return NextResponse.redirect(
    new URL("/dashboard/settings?discord=unlinked", env.siteUrl),
    303,
  );
}
