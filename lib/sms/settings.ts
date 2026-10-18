import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/email/secret";
import { isMissingSchemaError } from "@/lib/schema-ready";
import type { QuietHours } from "@/lib/sms/quiet-hours";
import { DEFAULT_HELP_TEXT, DEFAULT_QUIET_HOURS } from "@/lib/sms/policy";

/**
 * The single `sms_settings` row, plus the defaults it falls back to.
 *
 * Structurally the twin of lib/email/settings.ts, and every non-obvious choice
 * there is repeated here for the same reasons — read that file first if this one
 * looks over-careful. Two differences are deliberate and matter:
 *
 * 1. `configured` defaults to FALSE and gates sending, where email's equivalent
 *    gates only a UI notice. Email has a working default transport; SMS has no
 *    such thing. There is no address to fall back to and no free tier — an
 *    unconfigured SMS feature must be inert, not best-effort.
 *
 * 2. A failed read is fail-CLOSED. Email treats an unreadable settings row as
 *    "wait, don't guess", because guessing means the wrong From address. SMS
 *    treats it as "don't send at all", because the row carries the quiet-hours
 *    window and the pause switch, and sending with a default window to somebody
 *    whose local time we then mis-evaluate is the one outcome with damages
 *    attached.
 */

export type SmsSettings = {
  provider: "twilio" | "telnyx";
  fromNumber: string | null;
  accountSid: string | null;
  /** Decrypted at read time; never crosses into a client component. */
  authToken: string | null;
  smsPaused: boolean;
  maxSendsPerRun: number;
  quietHours: QuietHours;
  helpText: string;
  /** False when `sms_settings` itself is absent — the UI shows a migration note. */
  configured: boolean;
  /**
   * Set when the row could not be read for a reason other than the table being
   * absent. Callers about to send must treat this as "do not send" — see the
   * fail-closed note above.
   */
  readError: string | null;
};

export type PublicSmsSettings = Omit<SmsSettings, "authToken"> & {
  authTokenSet: boolean;
};

function defaults(): SmsSettings {
  return {
    provider: "twilio",
    fromNumber: null,
    accountSid: null,
    authToken: null,
    smsPaused: false,
    maxSendsPerRun: 300,
    // Mirrors the column defaults in 0106 (lib/sms/policy.ts keeps the pair).
    quietHours: { ...DEFAULT_QUIET_HOURS },
    helpText: DEFAULT_HELP_TEXT,
    configured: false,
    readError: null,
  };
}

// Same 30-second process cache as email, for the same reason: a blast is
// hundreds of sends and each one needs the window, the pause switch, and the
// credential. Short enough that flipping pause takes effect while the admin is
// still looking at the page.
let cache: { at: number; value: SmsSettings } | null = null;
const CACHE_MS = 30_000;

/** Drop the cache so the next send reflects a just-saved change immediately. */
export function invalidateSmsSettings() {
  cache = null;
}

/**
 * `fresh` skips the cache for the two readers that can't afford a stale row:
 * the drain re-checking the pause switch partway through a batch, and the
 * webhook re-checking the auth token after a signature fails (a token rotated
 * in another instance would otherwise 403 genuine requests for up to 30s, and
 * Twilio doesn't retry a 403).
 */
export async function getSmsSettings(opts: { fresh?: boolean } = {}): Promise<SmsSettings> {
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await loadSmsSettings();
  // Never cache a failed read: it would stretch one blip into thirty seconds of
  // refused sends, and the retry is one cheap query.
  if (!value.readError) cache = { at: Date.now(), value };
  return value;
}

async function loadSmsSettings(): Promise<SmsSettings> {
  const base = defaults();
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("sms_settings")
      .select("*")
      .eq("id", true)
      .maybeSingle();
    if (error) {
      // The missing table is the only error that means "0106 hasn't run". A
      // timeout is a failed read of a table that exists.
      if (isMissingSchemaError(error)) return base;
      return { ...base, configured: true, readError: error.message };
    }
    // 0106 seeds the row, so no row means a hand-restored database. The table is
    // there, so the defaults ARE the settings — but with no credential in them,
    // which leaves SMS correctly inert rather than half-configured.
    if (!data) return { ...base, configured: true };
    return {
      provider: data.provider === "telnyx" ? "telnyx" : "twilio",
      fromNumber: data.from_number ?? null,
      accountSid: data.account_sid ?? null,
      authToken: decryptSecret(data.auth_token_encrypted),
      smsPaused: Boolean(data.sms_paused),
      maxSendsPerRun: data.max_sends_per_run ?? base.maxSendsPerRun,
      quietHours: {
        startHour: data.quiet_start_hour ?? base.quietHours.startHour,
        endHour: data.quiet_end_hour ?? base.quietHours.endHour,
      },
      helpText: data.help_text || base.helpText,
      configured: true,
      readError: null,
    };
  } catch (err: any) {
    return {
      ...base,
      configured: true,
      readError: err?.message ?? "sms settings read failed",
    };
  }
}

export async function getPublicSmsSettings(): Promise<PublicSmsSettings> {
  const { authToken, ...rest } = await getSmsSettings();
  return { ...rest, authTokenSet: Boolean(authToken) };
}

/** Does this row have everything needed to actually send? */
export function hasCredentials(s: SmsSettings): boolean {
  return Boolean(s.fromNumber && s.accountSid && s.authToken);
}
