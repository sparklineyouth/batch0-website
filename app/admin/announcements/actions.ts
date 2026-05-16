"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/send";
import { notifyMany } from "@/lib/notifications";
import {
  postDiscordWebhook,
  postChannelMessage,
  announcementEmbed,
  getDiscordSettings,
} from "@/lib/discord";
import { env } from "@/lib/env";

export type AnnouncementInput = {
  cohortId: string | null; // null = all enrolled
  title: string;
  body: string;
  sendEmail: boolean;
  postDiscord: boolean;
};

export async function broadcastAnnouncement(
  input: AnnouncementInput,
): Promise<{ recipients: number; discordPosted: boolean; announcementId: string | null }> {
  const { userId: authorId } = await assertAdmin();
  if (!input.title.trim() || !input.body.trim()) {
    throw new Error("Title and body are required.");
  }
  const admin = createAdminClient();

  // Persist the announcement so the dashboard can show past
  // announcements + collect reactions. Done before the fan-out so the
  // notification "link" can deep-link straight to the announcement.
  let announcementId: string | null = null;
  try {
    const { data: ann, error: annErr } = await admin
      .from("announcements")
      .insert({
        cohort_id: input.cohortId,
        author_id: authorId,
        title: input.title.trim(),
        body: input.body.trim(),
      })
      .select("id")
      .single();
    if (annErr) {
      // Older deployments may not have run 0027 yet; degrade gracefully
      // — the broadcast still happens, just without a persisted row.
      if (!/relation .*announcements.* does not exist/i.test(annErr.message)) {
        console.error("[announcements] insert failed", annErr);
      }
    } else {
      announcementId = ann?.id ?? null;
    }
  } catch (err) {
    console.error("[announcements] insert threw", err);
  }

  let q = admin
    .from("enrollments")
    .select("user_id, profile:profiles(email, full_name)");
  if (input.cohortId) q = q.eq("cohort_id", input.cohortId);
  const { data: rows } = await q;
  const recipients = (rows ?? []) as any[];

  const notificationLink = announcementId
    ? `/dashboard/announcements#a-${announcementId}`
    : "/dashboard";

  // Always create in-app notifications.
  await notifyMany(
    recipients.map((r) => ({
      userId: r.user_id,
      type: "announcement",
      title: input.title.trim(),
      body: input.body.trim().slice(0, 240),
      link: notificationLink,
    })),
  );

  if (input.sendEmail) {
    const html = `<!doctype html>
<html><body style="margin:0;background:#0a0a0a;color:#e7e7e7;font-family:Inter,-apple-system,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0a0a0a;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;background:#111;border-radius:16px;border:1px solid rgba(255,255,255,0.08);padding:32px">
        <tr><td>
          <div style="font-weight:700;font-size:18px;color:#fff">Spark<span style="color:#facc15">Line</span> Youth</div>
          <h1 style="margin:18px 0 12px 0;font-size:22px;color:#fff">${escape(input.title)}</h1>
          <div style="font-size:15px;line-height:1.55;color:#e7e7e7;white-space:pre-wrap">${escape(input.body)}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
    for (const r of recipients) {
      const profile = Array.isArray(r.profile) ? r.profile[0] : r.profile;
      if (profile?.email) {
        await sendEmail({
          to: profile.email,
          subject: input.title.trim(),
          html,
        });
      }
    }
  }

  let discordPosted = false;
  if (input.postDiscord) {
    // Prefer the configured announcements channel via bot (richer
    // embed + better permissions story). Fall back to the legacy
    // webhook URL if no channel is configured.
    const settings = await getDiscordSettings();
    const embed = announcementEmbed({
      title: input.title.trim(),
      body: input.body.trim(),
      link: `${env.siteUrl}/dashboard`,
    });
    if (settings.announcementsChannelId) {
      discordPosted = await postChannelMessage(
        settings.announcementsChannelId,
        { embeds: [embed] },
      );
    } else {
      discordPosted = await postDiscordWebhook({ embeds: [embed] });
    }
  }

  await logAudit({
    action: "announcement.sent",
    payload: {
      title: input.title,
      cohortId: input.cohortId,
      recipients: recipients.length,
      sendEmail: input.sendEmail,
      postDiscord: input.postDiscord,
      discordPosted,
    },
  });

  return {
    recipients: recipients.length,
    discordPosted,
    announcementId,
  };
}

function escape(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function deleteAnnouncement(id: string) {
  await assertAdmin();
  const admin = createAdminClient();
  // Clear notifications that linked to this announcement so students
  // don't see a deep-link to a 404.
  await admin
    .from("notifications")
    .delete()
    .eq("type", "announcement")
    .like("link", `%a-${id}%`);
  const { error } = await admin.from("announcements").delete().eq("id", id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "announcement.deleted",
    targetType: "announcement",
    targetId: id,
  });
}
