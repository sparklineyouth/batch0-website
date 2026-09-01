"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { sendTemplated } from "@/lib/email/dispatch";
import { checkRateLimit } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import type { ActionResult } from "@/lib/action-result";

/**
 * Password reset, sent by us.
 *
 * This used to be `supabase.auth.resetPasswordForEmail()` called straight from
 * the browser, which hands delivery to Supabase's built-in mailer. Two things
 * were wrong with that:
 *
 *  1. It doesn't actually deliver. The built-in SMTP service is capped at a
 *     couple of messages per hour *for the whole project* and is explicitly
 *     documented as for testing only — every request past the cap fails, and
 *     the browser call reports success either way, so the user is told to
 *     check an inbox nothing is ever going to arrive in.
 *  2. What does arrive is an unbranded default template from a
 *     supabase.io address, on a site where every other transactional email
 *     goes out through Resend on our own domain.
 *
 * So we mint the recovery token ourselves with the service-role admin API
 * (`generateLink` creates the token but sends nothing) and put it in a real
 * batch0 email through the same Resend path as receipts and acceptances. The
 * token stays Supabase's — this changes who carries the envelope, not who
 * decides whether it's valid.
 */

/** How long Supabase's recovery tokens live; used for the copy only. */
const EXPIRY_MINUTES = 60;

export async function requestPasswordReset(
  rawEmail: string,
): Promise<ActionResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  // Two limits, because they stop different things: the per-email one stops
  // someone using us to flood a stranger's inbox, the per-IP one stops a
  // script walking a list of addresses. Both fail open (see lib/rate-limit).
  const ip = headers().get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const [byEmail, byIp] = await Promise.all([
    checkRateLimit({
      kind: "password-reset:email",
      identifier: email,
      limit: 3,
      windowSeconds: 900,
    }),
    checkRateLimit({
      kind: "password-reset:ip",
      identifier: ip,
      limit: 10,
      windowSeconds: 900,
    }),
  ]);
  if (!byEmail.ok || !byIp.ok) {
    return {
      ok: false,
      error: "Too many reset requests. Wait a few minutes and try again.",
    };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
  });

  // Deliberately not surfaced: "User not found" here would turn this form
  // into an account-existence oracle. Unknown addresses get the same
  // "check your email" screen as real ones, and nothing is sent.
  if (error || !data?.properties?.hashed_token) {
    if (error) console.warn("[forgot-password] generateLink:", error.message);
    return { ok: true };
  }

  // Our own confirm route, not the `action_link` Supabase returns. That link
  // goes to the Supabase domain and comes back in whichever flow the project
  // is configured for; /auth/confirm verifies the token hash server-side and
  // sets the session cookie itself, so the reset works the same on every
  // browser and the user only ever sees batch0.org.
  const url = new URL("/auth/confirm", env.siteUrl);
  url.searchParams.set("token_hash", data.properties.hashed_token);
  url.searchParams.set("type", "recovery");
  url.searchParams.set("next", "/reset");

  // The reset link is a required variable on the stored template: if an admin
  // edits the copy and drops the {{reset_url}} button, the render reports the
  // gap and sendTemplated falls back to the compiled version rather than
  // mailing someone a reset they can't complete.
  const sent = await sendTemplated("auth.password_reset", {
    to: email,
    vars: {
      reset_url: url.toString(),
      expires_minutes: EXPIRY_MINUTES,
    },
    fallback: () =>
      Templates.passwordReset({
        url: url.toString(),
        expiresInMinutes: EXPIRY_MINUTES,
      }),
  });

  // A send failure is worth telling the truth about — silently claiming
  // "check your email" is exactly the failure this whole change exists to
  // fix. "disabled" (no RESEND_API_KEY) is local dev, where send.ts logs the
  // message instead; don't fail the flow for that.
  if (!sent.ok && sent.reason !== "disabled") {
    return {
      ok: false,
      error: "We couldn't send the email just now. Try again in a minute.",
    };
  }

  return { ok: true };
}
