import { env } from "@/lib/env";

type EmailArgs = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
};

/**
 * Resend wrapper. No-ops (logs warning) when RESEND_API_KEY is unset
 * so dev + preview deploys without secrets configured don't break.
 */
export async function sendEmail(args: EmailArgs): Promise<void> {
  if (!env.resendApiKey) {
    console.warn(
      `[email] RESEND_API_KEY not set; would have sent to ${
        Array.isArray(args.to) ? args.to.join(",") : args.to
      } subject="${args.subject}"`,
    );
    return;
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
    }
  } catch (err) {
    console.error("[email] failed", err);
  }
}
