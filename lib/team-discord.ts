import { createAdminClient } from "@/lib/supabase/admin";
import {
  getDiscordSettings,
  provisionTeamChannels,
  syncTeamChannelOverwrites,
  deleteChannel,
  isDiscordEnabled,
} from "@/lib/discord";

/**
 * Resolve the Discord user IDs for every member of a team + every
 * mentor assigned to any of them. Members without a linked Discord
 * account just don't get an overwrite — they can still see the
 * channel after they link via /sync.
 */
async function loadTeamDiscordIds(
  admin: ReturnType<typeof createAdminClient>,
  teamId: string,
): Promise<{ memberDiscordIds: string[]; mentorDiscordIds: string[] }> {
  const { data: members } = await admin
    .from("team_members")
    .select("user_id, profile:profiles(discord_user_id)")
    .eq("team_id", teamId);
  const memberIds = (members ?? []).map((m: any) => m.user_id);
  const memberDiscordIds = (members ?? [])
    .map((m: any) => {
      const p = Array.isArray(m.profile) ? m.profile[0] : m.profile;
      return p?.discord_user_id;
    })
    .filter(Boolean) as string[];

  let mentorDiscordIds: string[] = [];
  if (memberIds.length > 0) {
    const { data: mentors } = await admin
      .from("mentor_assignments")
      .select("mentor_id, mentor:profiles(discord_user_id)")
      .in("student_id", memberIds);
    const seen = new Set<string>();
    for (const m of mentors ?? []) {
      const prof = Array.isArray((m as any).mentor)
        ? (m as any).mentor[0]
        : (m as any).mentor;
      const id = prof?.discord_user_id;
      if (id && !seen.has(id)) {
        seen.add(id);
        mentorDiscordIds.push(id);
      }
    }
  }

  return { memberDiscordIds, mentorDiscordIds };
}

/**
 * Create the team's text + voice channels if they don't exist; resync
 * the permission overwrites if they do. Idempotent — safe to call on
 * every membership change.
 *
 * Best-effort: if Discord is off / not configured, we silently no-op.
 * The team can use the channels later when an admin re-runs from the
 * teams admin page (TODO: ship that button next pass).
 */
export async function syncTeamDiscordChannels(teamId: string): Promise<void> {
  if (!(await isDiscordEnabled())) return;
  const admin = createAdminClient();
  const settings = await getDiscordSettings();
  if (!settings.teamsCategoryId) return; // not configured yet — silently skip

  const { data: team } = await admin
    .from("teams")
    .select("name, slug, discord_text_channel_id, discord_voice_channel_id")
    .eq("id", teamId)
    .maybeSingle();
  if (!team) return;

  const { memberDiscordIds, mentorDiscordIds } = await loadTeamDiscordIds(
    admin,
    teamId,
  );
  const adminRoleId = settings.roleIdByRole.admin ?? null;

  if (!(team as any).discord_text_channel_id || !(team as any).discord_voice_channel_id) {
    const provisioned = await provisionTeamChannels({
      teamName: (team as any).name,
      teamSlug: (team as any).slug,
      parentId: settings.teamsCategoryId,
      memberDiscordIds,
      mentorDiscordIds,
      adminRoleId,
    });
    if (provisioned.textChannelId || provisioned.voiceChannelId) {
      await admin
        .from("teams")
        .update({
          discord_text_channel_id:
            provisioned.textChannelId ??
            (team as any).discord_text_channel_id ??
            null,
          discord_voice_channel_id:
            provisioned.voiceChannelId ??
            (team as any).discord_voice_channel_id ??
            null,
        })
        .eq("id", teamId);
    }
    return;
  }

  // Already provisioned — just re-issue overwrites.
  await syncTeamChannelOverwrites({
    channelId: (team as any).discord_text_channel_id,
    isVoice: false,
    memberDiscordIds,
    mentorDiscordIds,
    adminRoleId,
  });
  await syncTeamChannelOverwrites({
    channelId: (team as any).discord_voice_channel_id,
    isVoice: true,
    memberDiscordIds,
    mentorDiscordIds,
    adminRoleId,
  });
}

/**
 * Tear down a team's Discord channels — called when the team itself is
 * deleted (last member left). The Discord channel IDs are stored on
 * the teams row, but the row is about to disappear, so we accept them
 * directly to avoid a race.
 */
export async function archiveTeamDiscordChannels(args: {
  textChannelId: string | null;
  voiceChannelId: string | null;
}): Promise<void> {
  if (!(await isDiscordEnabled())) return;
  if (args.textChannelId) await deleteChannel(args.textChannelId);
  if (args.voiceChannelId) await deleteChannel(args.voiceChannelId);
}
