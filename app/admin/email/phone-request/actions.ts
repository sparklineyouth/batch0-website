"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { sendEmailBatch } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { isValidPhone } from "@/lib/phone";

const TEMPLATE_KEY = "application.collect_phone";

// Same ceiling as the blast composer. A phone-request send should never be
// anywhere near this, but the guard costs nothing.
const MAX_RECIPIENTS = 1000;

export type PhoneRequestRecipient = {
  userId: string;
  email: string;
  name: string | null;
};

/**
 * Accepted students who still have no usable phone number on file.
 *
 * "Accepted" means their furthest-along application is `accepted` (they
 * haven't paid yet — a paid/enrolled student is past this). A number already
 * on file, or a non-deliverable placeholder address, drops them from the list,
 * which is what makes re-running the send safe: anyone who has since answered
 * simply isn't in the audience the second time.
 */
export async function getAcceptedMissingPhone(): Promise<
  { ok: true; recipients: PhoneRequestRecipient[] } | { ok: false; error: string }
> {
  await assertPermission("email.send");
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("applications")
    .select(
      "user_id, phone, created_at, profile:profiles!applications_user_id_fkey(email, full_name)",
    )
    .eq("status", "accepted")
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) return { ok: false, error: error.message };

  // Collapse to one row per user (their most recent accepted application wins,
  // and the query is already newest-first), skipping anyone who has a valid
  // number or only a placeholder address.
  const byUser = new Map<string, PhoneRequestRecipient>();
  for (const row of (data ?? []) as any[]) {
    const userId = row.user_id as string;
    if (!userId || byUser.has(userId)) continue;
    if (isValidPhone(String(row.phone ?? ""))) continue;
    const profile = Array.isArray(row.profile) ? row.profile[0] : row.profile;
    const email = profile?.email ?? null;
    if (!email || isPlaceholderEmail(email)) continue;
    byUser.set(userId, {
      userId,
      email,
      name: profile?.full_name ?? null,
    });
  }

  return { ok: true, recipients: Array.from(byUser.values()) };
}

export type PhoneRequestSendResult =
  | { ok: true; sent: number; failed: { to: string; reason: string }[] }
  | { ok: false; error: string };

/**
 * Email every accepted student who's still missing a phone number, pointing
 * them at /dashboard/phone. Re-resolves the audience server-side (the browser
 * never hands us addresses), so a stale page can't widen or redirect the send.
 */
export async function sendPhoneRequestToAccepted(): Promise<PhoneRequestSendResult> {
  const { userId } = await assertPermission("email.send");

  const audience = await getAcceptedMissingPhone();
  if (!audience.ok) return { ok: false, error: audience.error };

  const recipients = audience.recipients;
  if (recipients.length === 0) {
    return {
      ok: false,
      error: "Every accepted student already has a phone number on file.",
    };
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return {
      ok: false,
      error: `That resolves to ${recipients.length} recipients. Max ${MAX_RECIPIENTS} per send.`,
    };
  }

  const items = recipients.map((r) => {
    const t = Templates.collectPhone({ name: r.name });
    return {
      to: r.email,
      subject: t.subject,
      html: t.html,
      templateKey: TEMPLATE_KEY,
    };
  });

  const results = await sendEmailBatch(items);
  const failed = results
    .filter((r) => !r.ok)
    .map((r) => ({ to: r.to, reason: r.reason ?? "unknown" }));
  const sent = results.length - failed.length;

  await logAudit({
    action: "email.phone_request_sent",
    targetType: "email_blast",
    payload: {
      template: TEMPLATE_KEY,
      recipients: recipients.length,
      sent,
      failed: failed.length,
      sender: userId,
    },
  });

  return { ok: true, sent, failed };
}
