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
  /** Why it failed, if it did. Safe to expose to ops dashboards. */
  reason?: string;
};

/**
 * Resend wrapper. Returns success/failure so callers can tally failed
 * sends and surface them in cron status. Never throws — email failures
 * shouldn't tip over the operation triggering them.
 *
 * No-ops with `ok: false, reason: "no_api_key"` when RESEND_API_KEY is
 * unset so dev + preview deploys without secrets stay functional.
 */
export async function sendEmail(args: EmailArgs): Promise<EmailResult> {
  if (!env.resendApiKey) {
    console.warn(
      `[email] RESEND_API_KEY not set; would have sent to ${
        Array.isArray(args.to) ? args.to.join(",") : args.to
      } subject="${args.subject}"`,
    );
    return { ok: false, reason: "no_api_key" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.resendApiKey}`,
      },
      body: JSON.stringify({
        from: env.resendFrom,
        to: Array.isArray(args.to) ? args.to : [args.to],
        subject: args.subject,
        html: args.html,
        text: args.text,
        reply_to: args.replyTo ?? env.contactEmail,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[email] Resend error", res.status, body);
      return { ok: false, reason: `http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error("[email] failed", err);
    return { ok: false, reason: "exception" };
  }
}
