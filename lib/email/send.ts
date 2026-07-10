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
export type BatchItem = { to: string; subject: string; html: string };
export type BatchItemResult = {
  to: string;
  ok: boolean;
  id?: string;
  reason?: string;
};

// Resend's batch endpoint caps at 100 emails per request.
const BATCH_LIMIT = 100;

/**
 * Sends many personalized emails via Resend's batch API — one HTTP
 * request per 100 recipients instead of one per email, which keeps the
 * admin blast flow well inside serverless time limits and away from
 * per-request rate limits.
 *
 * The batch endpoint is all-or-nothing per request, so on a chunk
 * failure we retry that chunk one email at a time: a single bad address
 * shouldn't sink the other 99, and the caller gets per-recipient
 * failure reasons either way.
 */
export async function sendEmailBatch(
  items: BatchItem[],
): Promise<BatchItemResult[]> {
  const c = client();
  if (!c) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[email] RESEND_API_KEY not set; would have batch-sent ${items.length} emails`,
      );
    }
    return items.map((i) => ({ to: i.to, ok: false, reason: "disabled" }));
  }
  const results: BatchItemResult[] = [];
  for (let start = 0; start < items.length; start += BATCH_LIMIT) {
    const chunk = items.slice(start, start + BATCH_LIMIT);
    try {
      const { data, error } = await c.batch.send(
        chunk.map((i) => ({
          from: env.resendFrom,
          to: i.to,
          subject: i.subject,
          html: i.html,
          replyTo: env.contactEmail,
        })),
      );
      if (error) throw new Error(error.message);
      const ids = data?.data ?? [];
      chunk.forEach((i, idx) =>
        results.push({ to: i.to, ok: true, id: ids[idx]?.id }),
      );
    } catch (err: any) {
      console.error("[email] batch send failed; retrying individually", err);
      for (const i of chunk) {
        const r = await sendEmail({
          to: i.to,
          subject: i.subject,
          html: i.html,
        });
        results.push({ to: i.to, ok: r.ok, id: r.id, reason: r.reason });
      }
    }
  }
  return results;
}

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
