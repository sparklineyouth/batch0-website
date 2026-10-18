"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { encryptSecret } from "@/lib/email/secret";
import { isE164 } from "@/lib/phone";
import { invalidateSmsSettings } from "@/lib/sms/settings";

/**
 * The `sms_settings` singleton: which provider, which number, the quiet-hours
 * window, and the kill switch.
 *
 * Twin of app/admin/email/settings/actions.ts, including the write-only-secret
 * handling — the Twilio auth token is encrypted on the way in, never sent back
 * to the browser, and a blank field on save means "leave the stored one alone"
 * rather than "clear it". Saving the form to change the quiet-hours window must
 * not de-authenticate the account.
 *
 * Two things this has that email does not:
 *
 *  - There is no transport cache to reset. lib/sms/providers is stateless and
 *    reads the credential off the settings object it is handed, so
 *    invalidateSmsSettings() alone is enough. (SMTP pools a connection, which
 *    is why the email twin resets two caches.)
 *
 *  - Several values here are refused rather than merely warned about, because
 *    the DB check constraints are looser than the code that reads them: 0106
 *    accepts provider 'telnyx' and a start hour above the end hour, and both
 *    produce a silent failure at drain time. The validation below is where those
 *    become a readable error instead.
 */

export type SmsSettingsInput = {
  /** 'telnyx' is refused below — the column allows it, providerFor() throws. */
  provider: "twilio" | "telnyx";
  fromNumber: string;
  accountSid: string;
  /** Blank means "keep what's stored". Never treated as "clear it". */
  authToken: string;
  smsPaused: boolean;
  maxSendsPerRun: number;
  quietStartHour: number;
  quietEndHour: number;
  helpText: string;
};

/**
 * Ceiling on the appended disclosure.
 *
 * lib/sms/send.ts staples `helpText` onto the FIRST message every new number
 * receives, so every character here is charged against that message's segment
 * budget. 320 is two GSM-7 segments of disclosure — past that the compliance
 * footer costs more than the message it is attached to, which is a sign
 * something was pasted in by mistake.
 */
const HELP_TEXT_MAX = 320;

export async function saveSmsSettings(
  input: SmsSettingsInput,
): Promise<{ ok: boolean; error?: string }> {
  const { userId } = await assertPermission("sms.settings");

  if (input.provider !== "twilio") {
    return {
      ok: false,
      error:
        "Only Twilio is implemented. Add lib/sms/providers/telnyx.ts before selecting Telnyx — until then every send throws.",
    };
  }

  const from = input.fromNumber.trim();
  if (from && !isE164(from)) {
    return {
      ok: false,
      error:
        "The sending number must be E.164: a leading +, country code, then digits only — e.g. +18005550123.",
    };
  }

  if (
    !Number.isInteger(input.maxSendsPerRun) ||
    input.maxSendsPerRun < 1 ||
    input.maxSendsPerRun > 2000
  ) {
    return { ok: false, error: "Messages per run must be between 1 and 2000." };
  }

  if (
    !Number.isInteger(input.quietStartHour) ||
    input.quietStartHour < 0 ||
    input.quietStartHour > 23
  ) {
    return { ok: false, error: "Quiet-hours start must be an hour from 0 to 23." };
  }
  if (
    !Number.isInteger(input.quietEndHour) ||
    input.quietEndHour < 1 ||
    input.quietEndHour > 24
  ) {
    return { ok: false, error: "Quiet-hours end must be an hour from 1 to 24." };
  }
  // isWithinQuietHours is a straight `h >= start && h < end` test, so a window
  // that wraps midnight is not "overnight sending", it is a window no hour can
  // satisfy: nextAllowedSend walks eight days, returns null, and every message
  // parks as `skipped`. Refused here because the check constraints in 0106 are
  // per-column and cannot see the pair.
  if (input.quietStartHour >= input.quietEndHour) {
    return {
      ok: false,
      error:
        "The start hour must be before the end hour. A window that wraps past midnight can never be satisfied — every message would be parked rather than sent.",
    };
  }

  // A legal window can still be unsatisfiable. When an area code isn't in the map
  // in lib/sms/quiet-hours.ts, the window has to hold in BOTH fallback zones at
  // once — Eastern and Pacific, three hours apart — so anything narrower than
  // four hours leaves no overlap and those numbers never become sendable. The
  // drain now holds such a row for 24h instead of dropping it, but a setting that
  // guarantees the hold is worth refusing at the point somebody types it.
  const MIN_SATISFIABLE_HOURS = 4;
  if (input.quietEndHour - input.quietStartHour < MIN_SATISFIABLE_HOURS) {
    return {
      ok: false,
      error: `That window is only ${
        input.quietEndHour - input.quietStartHour
      } hour(s) wide. It needs at least ${MIN_SATISFIABLE_HOURS} so that numbers whose area code we can't place still have a sendable window (they have to satisfy Eastern and Pacific simultaneously).`,
    };
  }

  const help = input.helpText.trim();
  if (!help) {
    return {
      ok: false,
      error:
        "The disclosure can't be empty — CTIA requires a brand name, an opt-out instruction, and a rates notice in the first message a number receives.",
    };
  }
  if (help.length > HELP_TEXT_MAX) {
    return {
      ok: false,
      error: `The disclosure is ${help.length} characters (max ${HELP_TEXT_MAX}). It is appended to the first message each number gets, so it has to leave room for the message.`,
    };
  }

  const admin = createAdminClient();
  const patch: Record<string, any> = {
    id: true,
    provider: input.provider,
    from_number: from || null,
    account_sid: input.accountSid.trim() || null,
    sms_paused: input.smsPaused,
    max_sends_per_run: input.maxSendsPerRun,
    quiet_start_hour: input.quietStartHour,
    quiet_end_hour: input.quietEndHour,
    help_text: help,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  };
  // Only touch the token when a new one was typed. Editing the quiet-hours
  // window must never be able to wipe a working credential — same trade the
  // SMTP password makes, and the reason the field is write-only.
  const token = input.authToken.trim();
  if (token) {
    try {
      patch.auth_token_encrypted = encryptSecret(token);
    } catch (err: any) {
      // Refuse the whole save rather than storing the other fields and leaving
      // the admin believing the token went in.
      return { ok: false, error: err?.message ?? "Could not encrypt the auth token." };
    }
  }

  const { error } = await admin.from("sms_settings").upsert(patch, { onConflict: "id" });
  if (error) return { ok: false, error: error.message };

  // The 30-second settings cache holds the old window, the old pause state and
  // the old credential. Left alone, the next drain would authenticate as the
  // account that was just replaced.
  invalidateSmsSettings();

  await logAudit({
    action: "sms.settings_updated",
    targetType: "sms_settings",
    payload: {
      provider: input.provider,
      // The sending number is ours, not a recipient's, and "who repointed
      // sending at a different number" is the question this row answers.
      from: from || null,
      // An account SID identifies the Twilio account; it cannot send anything
      // on its own. The token is the credential and never appears here — not
      // its value, not its length, not a prefix.
      accountSid: patch.account_sid,
      tokenChanged: Boolean(token),
      paused: input.smsPaused,
      quietHours: `${input.quietStartHour}-${input.quietEndHour}`,
      maxSendsPerRun: input.maxSendsPerRun,
      helpTextChars: help.length,
    },
  });

  revalidatePath("/admin/sms/settings");
  revalidatePath("/admin/sms/outbox");
  revalidatePath("/admin/sms/blast");
  return { ok: true };
}

/**
 * Flip the kill switch on its own.
 *
 * Separate from the form save for the same reason email's is: the moment you
 * want this, you want it in one click, and re-submitting the whole form would
 * mean re-validating credentials you are not touching — and would fail outright
 * if the form happened to be holding a half-typed number.
 *
 * Pausing does not drop anything. Every send parks in `sms_outbox` as pending
 * and drains when resumed (sendSms in lib/sms/send.ts).
 */
export async function toggleSmsPause(
  paused: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { userId } = await assertPermission("sms.settings");
  const admin = createAdminClient();
  const { error } = await admin.from("sms_settings").upsert(
    {
      id: true,
      sms_paused: paused,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, error: error.message };

  invalidateSmsSettings();
  await logAudit({
    action: paused ? "sms.sending_paused" : "sms.sending_resumed",
    targetType: "sms_settings",
  });

  revalidatePath("/admin/sms/settings");
  revalidatePath("/admin/sms/outbox");
  revalidatePath("/admin/sms/blast");
  return { ok: true };
}
