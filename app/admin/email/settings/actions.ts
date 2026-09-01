"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { encryptSecret } from "@/lib/email/secret";
import { invalidateEmailSettings } from "@/lib/email/settings";
import { resetTransportCache, transportStatus, sendEmail } from "@/lib/email/send";

/**
 * Email settings: which transport, which sender, and the global pause switch.
 *
 * The sensitive part is the SMTP password. It is:
 *  - never sent back to the browser (the form shows "set" or "not set")
 *  - encrypted before it's stored (lib/email/secret.ts)
 *  - only replaceable, never readable — an admin who wants to check it has to
 *    enter a new one, which is the right trade for a Gmail app password
 */

export type EmailSettingsInput = {
  transport: "resend" | "smtp";
  fromName: string;
  fromEmail: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  /** Blank means "leave whatever is stored alone". */
  smtpPassword: string;
  automationsPaused: boolean;
  maxSendsPerRun: number;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function saveEmailSettings(
  input: EmailSettingsInput,
): Promise<{ ok: boolean; error?: string }> {
  const { userId } = await assertPermission("email.settings");

  if (!EMAIL_RE.test(input.fromEmail.trim())) {
    return { ok: false, error: "The From address isn't a valid email." };
  }
  if (input.replyTo.trim() && !EMAIL_RE.test(input.replyTo.trim())) {
    return { ok: false, error: "The Reply-to address isn't a valid email." };
  }
  if (input.transport === "smtp") {
    if (!input.smtpHost.trim()) return { ok: false, error: "SMTP host is required." };
    if (!input.smtpUser.trim()) return { ok: false, error: "SMTP username is required." };
    if (!Number.isInteger(input.smtpPort) || input.smtpPort < 1 || input.smtpPort > 65535) {
      return { ok: false, error: "SMTP port must be between 1 and 65535." };
    }
  }
  if (
    !Number.isInteger(input.maxSendsPerRun) ||
    input.maxSendsPerRun < 1 ||
    input.maxSendsPerRun > 2000
  ) {
    return { ok: false, error: "Sends per run must be between 1 and 2000." };
  }

  const admin = createAdminClient();
  const patch: Record<string, any> = {
    id: true,
    transport: input.transport,
    from_name: input.fromName.trim() || "batch0",
    from_email: input.fromEmail.trim(),
    reply_to: input.replyTo.trim() || null,
    smtp_host: input.smtpHost.trim() || null,
    smtp_port: input.smtpPort || null,
    smtp_secure: input.smtpSecure,
    smtp_user: input.smtpUser.trim() || null,
    automations_paused: input.automationsPaused,
    max_sends_per_run: input.maxSendsPerRun,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  };
  // Only touch the password when a new one was typed. Saving the form after
  // changing an unrelated field must not wipe a working credential.
  if (input.smtpPassword.trim()) {
    try {
      patch.smtp_password_encrypted = encryptSecret(input.smtpPassword.trim());
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "Could not encrypt the password." };
    }
  }

  const { error } = await admin.from("email_settings").upsert(patch, { onConflict: "id" });
  if (error) return { ok: false, error: error.message };

  // Both caches key off the old values — the settings cache and the pooled
  // SMTP connection. Left alone, the next send would authenticate as the
  // mailbox that was just replaced.
  invalidateEmailSettings();
  resetTransportCache();

  await logAudit({
    action: "email.settings_updated",
    targetType: "email_settings",
    payload: {
      transport: input.transport,
      from: input.fromEmail,
      smtpHost: input.smtpHost || null,
      smtpUser: input.smtpUser || null,
      // Never the password, not even its length.
      passwordChanged: Boolean(input.smtpPassword.trim()),
      paused: input.automationsPaused,
    },
  });

  revalidatePath("/admin/email/settings");
  revalidatePath("/admin/email/outbox");
  revalidatePath("/admin/email/automations");
  return { ok: true };
}

/** Open a connection (or check the API key) and report what happened. */
export async function testConnection(): Promise<{
  ok: boolean;
  message: string;
}> {
  await assertPermission("email.settings");
  invalidateEmailSettings();
  const status = await transportStatus();
  return { ok: status.ok, message: status.detail };
}

/**
 * End-to-end check: send a real message to the signed-in admin through
 * whatever transport is configured.
 *
 * `testConnection` proves the credentials work. This proves the *sender* does
 * — that the From address is one the transport will actually accept, which is
 * the failure Gmail and Resend both report at send time and not at auth time.
 */
export async function sendSettingsTest(): Promise<{
  ok: boolean;
  message: string;
}> {
  await assertPermission("email.settings");
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { ok: false, message: "No email on your account." };

  invalidateEmailSettings();
  const result = await sendEmail({
    to: user.email,
    subject: "batch0 email is working",
    html: `<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;background:#0a0a0a;color:#e7e7e7;padding:32px">
      <p>This is a test from <strong>/admin/email/settings</strong>.</p>
      <p>If you're reading it, the configured transport, credentials, and sender address all work.</p>
    </body></html>`,
    text: "This is a test from /admin/email/settings. If you're reading it, the transport works.",
  });

  return result.ok
    ? { ok: true, message: `Sent to ${user.email}. Check your inbox — and spam.` }
    : {
        ok: false,
        message:
          result.reason === "disabled"
            ? "No transport configured: set RESEND_API_KEY, or switch to SMTP and fill in a mailbox."
            : `Send failed: ${result.reason}`,
      };
}

/** Flip the global pause switch on its own, without saving the whole form. */
export async function setAutomationsPaused(
  paused: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { userId } = await assertPermission("email.settings");
  const admin = createAdminClient();
  const { error } = await admin
    .from("email_settings")
    .upsert(
      {
        id: true,
        automations_paused: paused,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
  if (error) return { ok: false, error: error.message };

  invalidateEmailSettings();
  await logAudit({
    action: paused ? "email.automations_paused" : "email.automations_resumed",
    targetType: "email_settings",
  });
  revalidatePath("/admin/email/settings");
  revalidatePath("/admin/email/automations");
  revalidatePath("/admin/email/outbox");
  return { ok: true };
}
