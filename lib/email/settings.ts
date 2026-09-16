import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { decryptSecret } from "@/lib/email/secret";
import { isMissingTable } from "@/lib/email/store";

/**
 * The single `email_settings` row, plus the defaults it falls back to.
 *
 * Every read goes through here so that an environment which hasn't run
 * migration 0052 behaves exactly like one that has and hasn't been touched:
 * Resend transport, the env-var sender, automations live. A missing table is
 * a "not configured yet" state, not an outage — the app sends transactional
 * email from a dozen places and none of them should break because an admin
 * hasn't opened the settings page.
 */

export type EmailSettings = {
  transport: "resend" | "smtp";
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string;
  /** Decrypted at read time; never crosses into a client component. */
  smtpPassword: string | null;
  automationsPaused: boolean;
  maxSendsPerRun: number;
  /**
   * False only when `email_settings` itself is absent — the UI shows a "run the
   * migration" note. Strictly the table, not the read: this used to be false
   * for *any* failed query, so a Supabase gateway timeout reported itself to
   * the cron log as "Email tables not found — run migration 0052" and sent the
   * operator hunting for a migration that had been applied for weeks.
   */
  configured: boolean;
  /**
   * Set when the row could not be read for some reason other than the table
   * being absent — a Supabase timeout, a Cloudflare 525 on the API gateway.
   *
   * Callers about to *send* must treat this as an unknown transport and wait,
   * not fall back to the env defaults: on a site configured for SMTP, those
   * defaults are a different transport and a different From address, so the
   * degraded path would put the wrong sender on real mail.
   */
  readError: string | null;
};

/** What the settings page is allowed to see. No secret, by construction. */
export type PublicEmailSettings = Omit<EmailSettings, "smtpPassword"> & {
  smtpPasswordSet: boolean;
};

function defaults(): EmailSettings {
  // env.resendFrom is "batch0 <hello@batch0.org>"; split it so the settings
  // form can show the two halves separately.
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(env.resendFrom);
  return {
    transport: "resend",
    fromName: (m?.[1] || "batch0").replace(/^"|"$/g, ""),
    fromEmail: m?.[2] || env.resendFrom.trim(),
    replyTo: env.contactEmail,
    smtpHost: null,
    smtpPort: null,
    smtpSecure: true,
    smtpUser: "",
    smtpPassword: null,
    automationsPaused: false,
    maxSendsPerRun: 200,
    configured: false,
    readError: null,
  };
}

/**
 * Short-lived process cache.
 *
 * Every `sendEmail()` call needs the settings, and a blast is hundreds of
 * sends — without this, one blast is one database round trip per recipient
 * just to re-read a row that changes a few times a year. Thirty seconds is
 * short enough that flipping the pause switch takes effect while the admin is
 * still looking at the page, and long enough that a queue drain reads it once.
 */
let cache: { at: number; value: EmailSettings } | null = null;
const CACHE_MS = 30_000;

/** Drop the cache so the next send reflects a just-saved change immediately. */
export function invalidateEmailSettings() {
  cache = null;
}

export async function getEmailSettings(): Promise<EmailSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await loadEmailSettings();
  // A failed read is not a settings state worth holding onto. Caching it would
  // make every send for the next thirty seconds use the env defaults, which on
  // an SMTP-configured site means real mail leaving from the wrong sender —
  // and it would stretch one blip into a half-minute of them.
  if (!value.readError) cache = { at: Date.now(), value };
  return value;
}

async function loadEmailSettings(): Promise<EmailSettings> {
  const base = defaults();
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("email_settings")
      .select("*")
      .eq("id", true)
      .maybeSingle();
    if (error) {
      // The missing table is the only error that actually means "0052 hasn't
      // run". A timeout is a failed read of a table that exists.
      if (isMissingTable(error)) return base;
      return { ...base, configured: true, readError: error.message };
    }
    // 0052 seeds the row, so no row means a hand-restored database. The table
    // is there, so the defaults *are* the settings — not a degraded state, and
    // not something to stop sending over.
    if (!data) return { ...base, configured: true };
    return {
      transport: data.transport === "smtp" ? "smtp" : "resend",
      fromName: data.from_name || base.fromName,
      fromEmail: data.from_email || base.fromEmail,
      replyTo: data.reply_to ?? base.replyTo,
      smtpHost: data.smtp_host ?? null,
      smtpPort: data.smtp_port ?? null,
      smtpSecure: data.smtp_secure ?? true,
      smtpUser: data.smtp_user ?? "",
      smtpPassword: decryptSecret(data.smtp_password_encrypted),
      automationsPaused: Boolean(data.automations_paused),
      maxSendsPerRun: data.max_sends_per_run ?? base.maxSendsPerRun,
      configured: true,
      readError: null,
    };
  } catch (err: any) {
    // Reaching here means the client or the decrypt threw, not that the table
    // is absent — so `configured` stays true and the reason is carried instead
    // of being flattened into a migration notice.
    return {
      ...base,
      configured: true,
      readError: err?.message ?? "email settings read failed",
    };
  }
}

export async function getPublicEmailSettings(): Promise<PublicEmailSettings> {
  const { smtpPassword, ...rest } = await getEmailSettings();
  return { ...rest, smtpPasswordSet: Boolean(smtpPassword) };
}

/** "batch0 <hello@batch0.org>" for the wire. */
export function formatFrom(s: {
  fromName: string | null;
  fromEmail: string;
}): string {
  const name = s.fromName?.trim();
  if (!name) return s.fromEmail;
  // A display name containing a comma or quote has to be quoted or the header
  // parses as two addresses.
  const quoted = /[",<>@]/.test(name) ? `"${name.replace(/"/g, "'")}"` : name;
  return `${quoted} <${s.fromEmail}>`;
}
