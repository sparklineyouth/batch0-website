"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { sendTemplated, emitEmailEvent } from "@/lib/email/dispatch";
import { notify } from "@/lib/notifications";
import { friendlyAuthError } from "@/lib/auth-errors";
import { HONEYPOT_MESSAGE, honeypotTripped } from "@/lib/honeypot";
import { checkRateLimit, clientIpFrom } from "@/lib/rate-limit";

/**
 * Signups one network may make in SIGNUP_IP_WINDOW_SECONDS. Generous on
 * purpose: a classroom or a school library is one address, and a teacher
 * walking a class through signup at an info session is the best day this
 * form has. A script is the other thing that arrives from one address, and
 * each account it makes is pre-confirmed and mailed a welcome — this caps it
 * at eighty an hour instead of as many as it can post.
 */
const SIGNUP_IP_LIMIT = 20;
const SIGNUP_IP_WINDOW_SECONDS = 15 * 60;

// Not exported: a "use server" module may export only async functions.
const SIGNUP_RATE_LIMITED =
  "A lot of accounts were just created from your network. Wait a few minutes, then try again.";

type SignUpInput = {
  email: string;
  password: string;
  fullName: string;
  /** The hidden honeypot field (lib/honeypot.ts). Empty for every person. */
  trap?: string;
};

type SignUpResult = { ok: true } | { ok: false; error: string };

/**
 * Create a new account with the email pre-confirmed.
 *
 * Email verification is disabled for now, so instead of the client-side
 * `supabase.auth.signUp` (which leaves the account unconfirmed and gated
 * behind a "check your email" link whenever the Supabase project has
 * "Confirm email" turned on), we mint the user server-side with the
 * service-role admin API and `email_confirm: true`. That guarantees the
 * account is usable immediately regardless of the hosted project's email
 * setting — the client can sign straight in afterward.
 *
 * The `on_auth_user_created` trigger still fires on the underlying
 * auth.users insert, so the profile row is created exactly as it would be
 * for a normal signup.
 */
export async function signUpAction(input: SignUpInput): Promise<SignUpResult> {
  // /apply is behind sign-in, so this form is where its anonymous traffic —
  // and any bot working through the funnel — actually arrives. An account
  // here is created pre-confirmed and sent a welcome email, so a script
  // filling this form costs a junk account and a message to whatever address
  // it typed. Refused before anything is created or sent, and logged at warn
  // so a wave of them is visible without paging anyone. No address in the
  // log line: it is whatever the bot typed.
  if (honeypotTripped(input.trap)) {
    console.warn("[signup] honeypot field was filled; no account created");
    return { ok: false, error: HONEYPOT_MESSAGE };
  }
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  const password = input.password;

  if (!email || !password) {
    return { ok: false, error: "Email and password are required." };
  }
  if (password.length < 8) {
    return {
      ok: false,
      error: "Pick a stronger password — at least 8 characters.",
    };
  }

  // Per network, after the checks above (a typo costs nothing) and before
  // anything is created, so a refused attempt mints no account and sends no
  // email. Every attempt that gets this far counts, including one for an
  // address that already has an account: that answer is itself something a
  // script would like to ask about many addresses. Fails open, like every
  // limit (lib/rate-limit.ts). Logged at warn without the address, like the
  // honeypot, so a wave is visible without paging anyone.
  const byIp = await checkRateLimit({
    kind: "signup:ip",
    identifier: clientIpFrom(await headers()),
    limit: SIGNUP_IP_LIMIT,
    windowSeconds: SIGNUP_IP_WINDOW_SECONDS,
  });
  if (!byIp.ok) {
    console.warn("[signup] per-network limit reached; no account created");
    return { ok: false, error: SIGNUP_RATE_LIMITED };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (error) {
    return { ok: false, error: friendlyAuthError(error) };
  }

  const user = data.user;

  // Best-effort welcome email + in-app notification, mirroring the old
  // email-confirmation callback. Failures are swallowed so a flaky email
  // integration never blocks account creation.
  if (user?.email) {
    try {
      // Prefers the admin-editable `auth.welcome` row and falls back to the
      // compiled copy when it isn't there — see lib/email/dispatch.ts.
      await sendTemplated("auth.welcome", {
        to: user.email,
        toName: fullName || null,
        userId: user.id,
        fallback: () => Templates.welcome({ name: fullName || null }),
      });
      // Awaited rather than fired-and-forgotten: a serverless invocation can
      // be frozen the moment its response is returned, and a floating promise
      // here would drop the enqueue silently. emitEmailEvent swallows its own
      // failures, so awaiting it can't fail the operation it reports on.
      await emitEmailEvent("user.signup", {
        email: user.email,
        name: fullName || null,
        userId: user.id,
        dedupeSeed: user.id,
      });
    } catch (err) {
      console.error("[signup] welcome email failed", err);
    }
    try {
      await notify({
        userId: user.id,
        type: "welcome",
        title: "Welcome to batch0",
        body: "Your account is ready. Apply when you're ready.",
        link: "/apply",
        dedupeKey: "welcome",
      });
    } catch (err) {
      console.error("[signup] welcome notification failed", err);
    }
  }

  return { ok: true };
}
