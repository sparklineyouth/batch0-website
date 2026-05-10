"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/send";
import { notifyMany } from "@/lib/notifications";
import { postDiscordWebhook } from "@/lib/discord";
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
): Promise<{ recipients: number; discordPosted: boolean }> {
  await assertAdmin();
  if (!input.title.trim() || !input.body.trim()) {
    throw new Error("Title and body are required.");
  }
  const admin = createAdminClient();

  let q = admin
    .from("enrollments")
    .select("user_id, profile:profiles(email, full_name)");
  if (input.cohortId) q = q.eq("cohort_id", input.cohortId);
  const { data: rows } = await q;
  const recipients = (rows ?? []) as any[];

  // Always create in-app notifications.
  await notifyMany(
    recipients.map((r) => ({
      userId: r.user_id,
      type: "announcement",
      title: input.title.trim(),
      body: input.body.trim().slice(0, 240),
      link: "/dashboard",
    })),
  );

  if (input.sendEmail) {
    const html = `<!doctype html>
<html><body style="margin:0;background:#0a0a0a;color:#e7e7e7;font-family:Inter,-apple-system,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0a0a0a;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;background:#111;border-radius:16px;border:1px solid rgba(255,255,255,0.08);padding:32px">
        <tr><td>
          <div style="font-weight:700;font-size:18px;color:#fff">Spark<span style="color:#facc15">Line</span></div>
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
    discordPosted = await postDiscordWebhook({
      content: `📣 **${input.title}**\n${input.body}\n\n— Posted from ${env.siteUrl}`,
    });
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

  return { recipients: recipients.length, discordPosted };
}

function escape(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
