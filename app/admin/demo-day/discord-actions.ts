"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import {
  postChannelMessageWithId,
  startThreadFromMessage,
  postChannelMessage,
  buttonRow,
  getDiscordSettings,
} from "@/lib/discord";

export type SpawnedThread = {
  teamId: string;
  teamName: string;
  threadId: string | null;
  reason?: string;
};

/**
 * For every team in the given cohort that's submitted a pitch, create
 * a Discord thread in the events channel with the team's deck/video
 * links + three audience-reaction buttons (🔥 💡 🚀). Button clicks
 * fire ddreact:<emoji>:<teamId> into /api/discord/interactions and
 * insert rows into demo_day_reactions (same table the website uses).
 *
 * Re-running on a cohort that already has threads will append new
 * threads — Discord doesn't dedupe, and we don't yet persist the
 * thread id on the team row. Admins should run this once per Demo
 * Day. Best-effort across teams; failures don't abort the loop.
 */
export async function postDemoDayPitchThreads(
  cohortId: string,
): Promise<{ spawned: SpawnedThread[]; channelMissing: boolean }> {
  await assertAdmin();
  const settings = await getDiscordSettings();
  if (!settings.eventsChannelId) {
    return { spawned: [], channelMissing: true };
  }

  const admin = createAdminClient();
  const [{ data: teams }, { data: pitches }] = await Promise.all([
    admin
      .from("teams")
      .select("id, name, slug, tagline, description")
      .eq("cohort_id", cohortId)
      .order("name"),
    admin
      .from("pitch_submissions")
      .select("team_id, deck_path, video_url, video_path, submitted_at")
      .not("submitted_at", "is", null),
  ]);
  const pitchByTeam = new Map<string, any>(
    (pitches ?? []).map((p: any) => [p.team_id, p]),
  );

  const spawned: SpawnedThread[] = [];
  for (const t of (teams ?? []) as any[]) {
    const p = pitchByTeam.get(t.id);
    if (!p) {
      spawned.push({ teamId: t.id, teamName: t.name, threadId: null, reason: "no submission" });
      continue;
    }
    const lines: string[] = [];
    if (t.tagline) lines.push(`_${t.tagline}_`);
    if (p.video_url) lines.push(`▶ [Pitch video](${p.video_url})`);
    // Deck + uploaded-video files live in private storage — we don't
    // share them here to avoid leaking signed URLs into a public
    // channel. Audience members can watch the full pitch on the site.
    lines.push(`\nReact below — your taps land on the leaderboard.`);

    const messageId = await postChannelMessageWithId(
      settings.eventsChannelId,
      {
        embeds: [
          {
            title: `🚀 ${t.name}`,
            description: lines.join("\n"),
            color: 0xfacc15,
          },
        ],
        components: [
          buttonRow([
            { customId: `ddreact:🔥:${t.id}`, label: "Fire", emoji: "🔥", style: 2 },
            { customId: `ddreact:💡:${t.id}`, label: "Smart", emoji: "💡", style: 2 },
            { customId: `ddreact:🚀:${t.id}`, label: "Send it", emoji: "🚀", style: 2 },
          ]),
        ],
      },
    );

    let threadId: string | null = null;
    if (messageId) {
      threadId = await startThreadFromMessage({
        channelId: settings.eventsChannelId,
        messageId,
        name: `Demo Day · ${t.name}`,
        autoArchiveMinutes: 1440,
      });
      if (threadId) {
        // Seed the thread with a kickoff so it shows up in the sidebar.
        await postChannelMessage(threadId, {
          content: `Live discussion for **${t.name}** — drop your questions and 🔥/💡/🚀 above.`,
        });
      }
    }

    spawned.push({
      teamId: t.id,
      teamName: t.name,
      threadId,
      reason: messageId ? undefined : "post failed",
    });
  }

  revalidatePath("/admin/demo-day");
  return { spawned, channelMissing: false };
}
