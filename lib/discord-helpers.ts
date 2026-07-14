import { createAdminClient } from "@/lib/supabase/admin";
import {
  getDiscordSettings,
  sendDirectMessage,
  buttonRow,
  editChannelMessage,
  postAndPinMessage,
  saveDiscordSetting,
} from "@/lib/discord";

/**
 * The onboarding DM the bot sends after a user runs /link or /start.
 * Returns true on success; false if Discord refused the DM (recipient
 * disabled DMs from server members — Discord's default for many users).
 */
export async function sendOnboardingDM(
  admin: ReturnType<typeof createAdminClient>,
  discordUserId: string,
): Promise<boolean> {
  const { data: profile } = await admin
    .from("profiles")
    .select(
      "id, full_name, discord_introduced_at, discord_first_rsvp_at, discord_linked_at",
    )
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!profile) return false;

  const settings = await getDiscordSettings();
  const introCh = settings.introductionsChannelId;
  const eventsCh = settings.eventsChannelId;

  const linkedDone = !!profile.discord_linked_at;
  const introDone = !!profile.discord_introduced_at;
  const rsvpDone = !!profile.discord_first_rsvp_at;

  const lines = [
    `Welcome${profile.full_name ? `, ${profile.full_name}` : ""}!`,
    "",
    "Here's your 3-step setup:",
    `1. ${linkedDone ? "✅" : "⬜"} Link your batch0 account`,
    `2. ${introDone ? "✅" : "⬜"} Introduce yourself${introCh ? ` in <#${introCh}>` : ""}`,
    `3. ${rsvpDone ? "✅" : "⬜"} RSVP to an event${eventsCh ? ` in <#${eventsCh}>` : ""}`,
  ];

  const buttons: { customId: string; label: string; style?: 1 | 2 | 3 | 4 }[] = [];
  if (!introDone) {
    buttons.push({ customId: "onb:intro", label: "Mark intro done", style: 3 });
  }
  if (!rsvpDone) {
    buttons.push({ customId: "onb:rsvp-info", label: "How to RSVP", style: 2 });
  }
  const components = buttons.length ? [buttonRow(buttons)] : [];

  // Mark when we last nudged so the admin-feed can show stalled members.
  await admin
    .from("profiles")
    .update({ discord_onboarded_nudged_at: new Date().toISOString() })
    .eq("id", profile.id);

  return await sendDirectMessage(discordUserId, {
    embeds: [
      {
        title: "Welcome to batch0 👋",
        description: lines.join("\n"),
        color: 0xffbb00,
      },
    ],
    ...(components.length ? { components } : {}),
  } as any);
}

export type OncallRow = {
  mentorId: string;
  displayName: string;
  discordUserId: string | null;
  note: string | null;
  expiresAt: string | null;
  expiresAtEpoch: number;
};

/**
 * Drop expired rows opportunistically, then return everyone still
 * marked on-call. Used by both `/oncall list` and the pinned-message
 * refresher.
 */
export async function currentOncall(
  admin: ReturnType<typeof createAdminClient>,
): Promise<OncallRow[]> {
  await admin
    .from("mentor_oncall")
    .delete()
    .lt("expires_at", new Date().toISOString());

  const { data } = await admin
    .from("mentor_oncall")
    .select("mentor_id, note, expires_at, mentor:profiles(full_name, discord_user_id)")
    .order("started_at", { ascending: false });
  return (data ?? []).map((r: any) => {
    const m = Array.isArray(r.mentor) ? r.mentor[0] : r.mentor;
    return {
      mentorId: r.mentor_id,
      displayName: m?.full_name ?? "Mentor",
      discordUserId: m?.discord_user_id ?? null,
      note: r.note,
      expiresAt: r.expires_at,
      expiresAtEpoch: r.expires_at
        ? Math.floor(new Date(r.expires_at).getTime() / 1000)
        : 0,
    };
  });
}

/**
 * Re-render the persistent "Mentors on-call right now" pin in #help.
 * First call creates and pins; subsequent calls edit in place.
 */
export async function refreshOncallPin(
  admin: ReturnType<typeof createAdminClient>,
): Promise<void> {
  try {
    const settings = await getDiscordSettings();
    if (!settings.helpChannelId) return;
    const rows = await currentOncall(admin);
    const content =
      rows.length === 0
        ? "**Mentors on-call right now:** _nobody_. Drop your question — we'll get to you next round."
        : [
            "**Mentors on-call right now:**",
            ...rows.map(
              (r) =>
                `• <@${r.discordUserId}>${r.note ? ` — ${r.note}` : ""}${
                  r.expiresAt ? ` (until <t:${r.expiresAtEpoch}:t>)` : ""
                }`,
            ),
          ].join("\n");
    if (settings.oncallMessageId) {
      const ok = await editChannelMessage(
        settings.helpChannelId,
        settings.oncallMessageId,
        { content, allowedMentions: { parse: [] } },
      );
      if (ok) return;
    }
    const newId = await postAndPinMessage(settings.helpChannelId, {
      content,
      allowedMentions: { parse: [] },
    });
    if (newId) {
      await saveDiscordSetting("discord_oncall_message_id", newId);
    }
  } catch (err) {
    console.error("[discord] refreshOncallPin failed", err);
  }
}
