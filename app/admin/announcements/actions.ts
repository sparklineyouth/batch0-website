"use server";
import { revalidateTag } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { cohortContentTag, GLOBAL_CONTENT_TAG } from "@/lib/app-cache";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/send";
import { notifyMany } from "@/lib/notifications";
import { postToChannel } from "@/lib/chat-post";

export type AnnouncementInput = {
  cohortId: string | null; // null = all enrolled
  title: string;
  body: string;
  sendEmail: boolean;
  /** Also post it in #announcements in batch0 Chat. */
  postChat: boolean;
  /** Ping everyone who can read #announcements (@everyone). Off by default. */
  mentionEveryone?: boolean;
};

export type AnnouncementResult = {
  recipients: number;
  chatPosted: boolean;
  /** Why the #announcements post didn't land, when it was asked for and failed. */
  chatError: string | null;
  announcementId: string | null;
};

export async function broadcastAnnouncement(
  input: AnnouncementInput,
): Promise<AnnouncementResult> {
  const { userId: authorId } = await assertPermission("announcements.manage");
  if (!input.title.trim() || !input.body.trim()) {
    throw new Error("Title and body are required.");
  }
  const admin = createAdminClient();

  // Persist the announcement so the dashboard can show past
  // announcements. Done before the fan-out so the notification "link" can
  // deep-link straight to the announcement.
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
      // The broadcast still goes out, just without a persisted row.
      console.error("[announcements] insert failed", annErr);
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
          <div style="font-weight:700;font-size:18px;color:#fff"><span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">batch<span style="color:#ffbb00">0</span></span></div>
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

  let chatPosted = false;
  let chatError: string | null = null;
  const mentionEveryone = input.postChat && !!input.mentionEveryone;
  if (input.postChat) {
    // An announcement for everyone goes to #announcements; one for a single
    // cohort goes to that cohort's own channel, where only that cohort (and
    // staff) reads it — so its words and any @everyone ping stay inside the
    // audience the email went to.
    // postToChannel never throws: a chat copy that doesn't land is reported
    // back to the composer, it doesn't undo the notifications and emails
    // that already went out.
    const posted = await postToChannel(
      { systemKey: input.cohortId ? `cohort:${input.cohortId}` : "announcements" },
      {
        senderId: authorId,
        body: chatAnnouncementBody({ title: input.title, body: input.body }),
        mentionEveryone,
      },
    );
    chatPosted = posted.ok;
    if (!posted.ok) {
      chatError = posted.reason;
      console.error("[announcements] chat post failed", posted.reason);
    }
  }

  // The mobile app caches announcements per cohort for a minute
  // (lib/app-cache.ts), and the whole point of sending one from a phone is that
  // it lands now. Bust the exact scope this went to; the global tag covers the
  // cohort-less "everyone" case and is also read by every cohort-scoped view.
  revalidateTag(
    input.cohortId ? cohortContentTag(input.cohortId) : GLOBAL_CONTENT_TAG,
  );
  if (input.cohortId) revalidateTag(GLOBAL_CONTENT_TAG);

  await logAudit({
    action: "announcement.sent",
    payload: {
      title: input.title,
      cohortId: input.cohortId,
      recipients: recipients.length,
      sendEmail: input.sendEmail,
      postChat: input.postChat,
      mentionEveryone,
      chatPosted,
    },
  });

  return {
    recipients: recipients.length,
    chatPosted,
    chatError,
    announcementId,
  };
}

/**
 * The #announcements copy: the title in bold, who it's for when it isn't
 * everyone, then the message as written (chat renders **bold**, *italic*,
 * `code` and bare links itself).
 */
function chatAnnouncementBody(args: { title: string; body: string }): string {
  return `**${args.title.trim()}**\n\n${args.body.trim()}`;
}

function escape(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function deleteAnnouncement(id: string) {
  await assertPermission("announcements.manage");
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
  // Same reasoning as the send path: a deleted announcement must stop showing
  // in the app immediately, not after the content cache expires.
  revalidateTag(GLOBAL_CONTENT_TAG);
  await logAudit({
    action: "announcement.deleted",
    targetType: "announcement",
    targetId: id,
  });
}
