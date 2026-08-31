import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { decryptSecret } from "@/lib/email/secret";

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
  /** False when the table is missing — the UI shows a "run the migration" note. */
  configured: boolean;
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
  cache = { at: Date.now(), value };
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
    if (error || !data) return base;
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
    };
  } catch {
    return base;
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
