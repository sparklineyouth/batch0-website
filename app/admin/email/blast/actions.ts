"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { sendEmail, sendEmailBatch } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";

export type BlastDraft = {
  subject: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
};

export type BlastSendResult =
  | {
      ok: true;
      sent: number;
      failed: { to: string; reason: string }[];
    }
  | { ok: false; error: string };

// Hard ceiling per blast. Well above any realistic cohort size; exists
// so a bugged "select everyone" click can't turn into a spam cannon.
const MAX_RECIPIENTS = 1000;

function firstName(full: string | null | undefined): string {
  const first = (full ?? "").trim().split(/\s+/)[0];
  return first || "there";
}

function personalize(text: string, name: string): string {
  return text.split("{{name}}").join(name);
}

/**
 * Server actions can't safely throw (messages are masked in prod), so
 * validation returns a typed result the form renders inline.
 */
function validateDraft(
  draft: BlastDraft,
):
  | { ok: true; subject: string; body: string; cta: { url: string; label: string } | null }
  | { ok: false; error: string } {
  const subject = draft.subject.trim();
  const body = draft.body.trim();
  if (!subject) return { ok: false, error: "Subject is required." };
  if (!body) return { ok: false, error: "Email body is required." };
  const ctaLabel = draft.ctaLabel?.trim();
  const ctaUrl = draft.ctaUrl?.trim();
  if ((ctaLabel && !ctaUrl) || (!ctaLabel && ctaUrl)) {
    return {
      ok: false,
      error: "Button needs both a label and a URL (or leave both empty).",
    };
  }
  if (ctaUrl && !/^https?:\/\//i.test(ctaUrl)) {
    return { ok: false, error: "Button URL must start with http(s)://." };
  }
  return {
    ok: true,
    subject,
    body,
    cta: ctaLabel && ctaUrl ? { label: ctaLabel, url: ctaUrl } : null,
  };
}

/** Render the branded HTML for the live preview pane. */
export async function renderBlastPreview(
  draft: BlastDraft,
): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  await assertAdmin();
  const v = validateDraft(draft);
  if (!v.ok) return v;
  const { html } = Templates.blast({
    bodyText: personalize(v.body, "Alex"),
    preheader: v.subject,
    cta: v.cta,
  });
  return { ok: true, html };
}

/** Send the draft to the signed-in admin only — a real end-to-end test. */
export async function sendTestBlast(
  draft: BlastDraft,
): Promise<{ ok: boolean; message: string }> {
  await assertAdmin();
  const v = validateDraft(draft);
  if (!v.ok) return { ok: false, message: v.error };

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { ok: false, message: "No email on your account." };

  const { html } = Templates.blast({
    bodyText: personalize(v.body, firstName(user.user_metadata?.full_name)),
    preheader: v.subject,
    cta: v.cta,
  });
  const result = await sendEmail({
    to: user.email,
    subject: `[TEST] ${v.subject}`,
    html,
  });
  return result.ok
    ? { ok: true, message: `Test sent to ${user.email}.` }
    : {
        ok: false,
        message:
          result.reason === "disabled"
            ? "Email is disabled — RESEND_API_KEY isn't set in this environment."
            : `Send failed: ${result.reason}`,
      };
}

/** Send the blast to every selected recipient, personalized per student. */
export async function sendBlast(
  recipientIds: string[],
  draft: BlastDraft,
): Promise<BlastSendResult> {
  const { userId } = await assertAdmin();
  const v = validateDraft(draft);
  if (!v.ok) return v;

  const ids = Array.from(new Set(recipientIds)).filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "No recipients selected." };
  if (ids.length > MAX_RECIPIENTS) {
    return {
      ok: false,
      error: `Too many recipients (${ids.length}). Max ${MAX_RECIPIENTS} per blast.`,
    };
  }

  // Resolve emails server-side from the ids — the client only ever
  // hands us profile ids, so a tampered request can't make us email
  // arbitrary addresses.
  const admin = createAdminClient();
  const recipients: { email: string; full_name: string | null }[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await admin
      .from("profiles")
      .select("email, full_name")
      .in("id", ids.slice(i, i + 500));
    if (error) return { ok: false, error: error.message };
    for (const row of data ?? []) {
      if (row.email) recipients.push(row);
    }
  }
  if (recipients.length === 0) {
    return { ok: false, error: "None of the selected recipients have an email." };
  }

  const items = recipients.map((r) => ({
    to: r.email,
    subject: v.subject,
    html: Templates.blast({
      bodyText: personalize(v.body, firstName(r.full_name)),
      preheader: v.subject,
      cta: v.cta,
    }).html,
  }));

  const results = await sendEmailBatch(items);
  const failed = results
    .filter((r) => !r.ok)
    .map((r) => ({ to: r.to, reason: r.reason ?? "unknown" }));
  const sent = results.length - failed.length;

  await logAudit({
    action: "email.blast_sent",
    targetType: "email_blast",
    payload: {
      subject: v.subject,
      requested: ids.length,
      sent,
      failed: failed.length,
      sender: userId,
    },
  });

  return { ok: true, sent, failed };
}
