import { Resend } from "resend";
import { env } from "@/lib/env";

type EmailArgs = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
};

export type EmailResult = {
  ok: boolean;
  reason?: string;
  id?: string;
};

let cached: Resend | null = null;
function client(): Resend | null {
  if (!env.resendApiKey) return null;
  if (!cached) cached = new Resend(env.resendApiKey);
  return cached;
}

/**
 * Sends transactional email via Resend. When `RESEND_API_KEY` isn't
 * set the call no-ops with `{ ok: false, reason: "disabled" }` so the
 * surrounding flows keep working in local dev.
 *
 * Note: this is the channel for app-driven transactional mail
 * (acceptance, receipts, fee notices, weekly digests). Account
 * verification + password-reset emails are sent by Supabase Auth
 * directly — to make those look professional too, configure custom
 * SMTP in the Supabase dashboard (Auth → SMTP settings) and point it
 * at the same Resend account.
 */
export async function sendEmail(args: EmailArgs): Promise<EmailResult> {
  const c = client();
  if (!c) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[email] RESEND_API_KEY not set; would have sent to ${
          Array.isArray(args.to) ? args.to.join(",") : args.to
        } subject="${args.subject}"`,
      );
    }
    return { ok: false, reason: "disabled" };
  }
  try {
    const { data, error } = await c.emails.send({
      from: env.resendFrom,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      replyTo: args.replyTo ?? env.contactEmail,
    });
    if (error) {
      console.error("[email] resend send failed", error);
      return { ok: false, reason: error.message };
    }
    return { ok: true, id: data?.id };
  } catch (err: any) {
    console.error("[email] resend send threw", err);
    return { ok: false, reason: err?.message ?? "unknown" };
  }
}
