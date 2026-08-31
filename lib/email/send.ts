import { Resend } from "resend";
import type { Transporter } from "nodemailer";
import { env } from "@/lib/env";
import {
  getEmailSettings,
  formatFrom,
  type EmailSettings,
} from "@/lib/email/settings";

type EmailArgs = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /** Overrides the configured sender. Set by a template with its own From. */
  from?: string;
  /** Tag written into the Resend payload / SMTP headers for the metrics page. */
  templateKey?: string;
};

export type EmailResult = {
  ok: boolean;
  reason?: string;
  id?: string;
};

/**
 * Two transports, one interface.
 *
 * Resend is the default and the one the domain is verified against. SMTP
 * exists because an admin asked to "just send from my Gmail" — connecting a
 * Google account with an app password is three clicks on their side and no
 * DNS work, which is the difference between sending today and sending after
 * a domain-verification round trip. It also covers any other relay, since
 * it's plain SMTP underneath.
 *
 * Which one is live is a database setting, not an env var, so switching is
 * something an admin does at /admin/email/settings rather than a deploy.
 */

let cachedResend: Resend | null = null;
function resendClient(): Resend | null {
  if (!env.resendApiKey) return null;
  if (!cachedResend) cachedResend = new Resend(env.resendApiKey);
  return cachedResend;
}

// One pooled transporter per credential set. Rebuilt when the settings
// change, because a stale pool would keep authenticating as the old account
// after an admin swaps the connected mailbox.
let cachedSmtp: { fingerprint: string; tx: Transporter } | null = null;

async function smtpTransport(s: EmailSettings): Promise<Transporter | null> {
  if (!s.smtpHost || !s.smtpUser || !s.smtpPassword) return null;
  const fingerprint = [
    s.smtpHost,
    s.smtpPort,
    s.smtpSecure,
    s.smtpUser,
    s.smtpPassword.length,
  ].join("|");
  if (cachedSmtp?.fingerprint === fingerprint) return cachedSmtp.tx;
  const nodemailer = await import("nodemailer");
  const tx = nodemailer.createTransport({
    host: s.smtpHost,
    port: s.smtpPort ?? 587,
    secure: s.smtpSecure,
    auth: { user: s.smtpUser, pass: s.smtpPassword },
    pool: true,
    maxConnections: 3,
    // Gmail throttles aggressively on burst; a modest cap keeps a blast from
    // tripping "suspicious activity" and locking the account mid-send.
    maxMessages: 50,
  });
  cachedSmtp = { fingerprint, tx };
  return tx;
}

/** Forget the pooled SMTP connection — called after a settings save. */
export function resetTransportCache() {
  cachedSmtp?.tx.close?.();
  cachedSmtp = null;
}

export type TransportStatus =
  | { ok: true; transport: "resend" | "smtp"; detail: string }
  | { ok: false; transport: "resend" | "smtp"; detail: string };

/**
 * Is email actually going to leave the building? Rendered on the settings
 * page, because "I saved it and nothing happened" is otherwise unanswerable
 * without reading logs.
 */
export async function transportStatus(): Promise<TransportStatus> {
  const s = await getEmailSettings();
  if (s.transport === "smtp") {
    if (!s.smtpHost || !s.smtpUser || !s.smtpPassword) {
      return {
        ok: false,
        transport: "smtp",
        detail: "SMTP is selected but the host, username, or password is missing.",
      };
    }
    try {
      const tx = await smtpTransport(s);
      await tx!.verify();
      return {
        ok: true,
        transport: "smtp",
        detail: `Connected to ${s.smtpHost} as ${s.smtpUser}.`,
      };
    } catch (err: any) {
      return {
        ok: false,
        transport: "smtp",
        detail: err?.message ?? "Could not connect to the SMTP server.",
      };
    }
  }
  return env.resendApiKey
    ? { ok: true, transport: "resend", detail: `Sending as ${formatFrom(s)} via Resend.` }
    : {
        ok: false,
        transport: "resend",
        detail: "RESEND_API_KEY isn't set in this environment.",
      };
}

/**
 * Sends transactional email.
 *
 * When no transport is configured the call no-ops with
 * `{ ok: false, reason: "disabled" }` so the surrounding flows keep working
 * in local dev.
 *
 * Note: account verification email is still sent by Supabase Auth directly.
 * Password reset is not — it goes through here (see
 * app/(auth)/forgot-password/actions.ts) because Supabase's free-tier mailer
 * caps at a couple of messages an hour project-wide.
 */
export async function sendEmail(args: EmailArgs): Promise<EmailResult> {
  const s = await getEmailSettings();
  const from = args.from ?? formatFrom(s);
  const replyTo = args.replyTo ?? s.replyTo ?? env.contactEmail;

  if (s.transport === "smtp") {
    const tx = await smtpTransport(s);
    if (!tx) return disabled(args, "SMTP selected but not configured");
    try {
      const info = await tx.sendMail({
        from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
        replyTo,
        headers: args.templateKey ? { "X-Batch0-Template": args.templateKey } : undefined,
      });
      return { ok: true, id: info.messageId };
    } catch (err: any) {
      console.error("[email] smtp send failed", err);
      return { ok: false, reason: err?.message ?? "smtp error" };
    }
  }

  const c = resendClient();
  if (!c) return disabled(args, "disabled");
  try {
    const { data, error } = await c.emails.send({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      replyTo,
      headers: args.templateKey ? { "X-Batch0-Template": args.templateKey } : undefined,
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

function disabled(args: EmailArgs, reason: string): EmailResult {
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[email] no transport configured; would have sent to ${
        Array.isArray(args.to) ? args.to.join(",") : args.to
      } subject="${args.subject}"`,
    );
  }
  return { ok: false, reason: reason === "disabled" ? "disabled" : reason };
}

export type BatchItem = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  templateKey?: string;
};
export type BatchItemResult = {
  to: string;
  ok: boolean;
  id?: string;
  reason?: string;
};

// Resend's batch endpoint caps at 100 emails per request.
const BATCH_LIMIT = 100;

/**
 * Sends many personalized emails — one HTTP request per 100 recipients on
 * Resend instead of one per email, which keeps the admin blast flow well
 * inside serverless time limits and away from per-request rate limits.
 *
 * Resend's batch endpoint is all-or-nothing per request, so on a chunk
 * failure we retry that chunk one email at a time: a single bad address
 * shouldn't sink the other 99, and the caller gets per-recipient failure
 * reasons either way.
 *
 * SMTP has no batch verb, so that transport falls through to sequential
 * sends over the pooled connection.
 */
export async function sendEmailBatch(
  items: BatchItem[],
): Promise<BatchItemResult[]> {
  if (items.length === 0) return [];
  const s = await getEmailSettings();

  if (s.transport === "smtp") {
    const results: BatchItemResult[] = [];
    for (const i of items) {
      const r = await sendEmail({
        to: i.to,
        subject: i.subject,
        html: i.html,
        text: i.text,
        templateKey: i.templateKey,
      });
      results.push({ to: i.to, ok: r.ok, id: r.id, reason: r.reason });
    }
    return results;
  }

  const c = resendClient();
  if (!c) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[email] no transport configured; would have batch-sent ${items.length} emails`,
      );
    }
    return items.map((i) => ({ to: i.to, ok: false, reason: "disabled" }));
  }

  const from = formatFrom(s);
  const replyTo = s.replyTo ?? env.contactEmail;
  const results: BatchItemResult[] = [];
  for (let start = 0; start < items.length; start += BATCH_LIMIT) {
    const chunk = items.slice(start, start + BATCH_LIMIT);
    try {
      const { data, error } = await c.batch.send(
        chunk.map((i) => ({
          from,
          to: i.to,
          subject: i.subject,
          html: i.html,
          text: i.text,
          replyTo,
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
          text: i.text,
        });
        results.push({ to: i.to, ok: r.ok, id: r.id, reason: r.reason });
      }
    }
  }
  return results;
}
