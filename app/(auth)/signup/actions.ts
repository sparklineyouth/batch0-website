"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { notify } from "@/lib/notifications";
import { friendlyAuthError } from "@/lib/auth-errors";

type SignUpInput = {
  email: string;
  password: string;
  fullName: string;
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
      const t = Templates.welcome({ name: fullName || null });
      await sendEmail({ to: user.email, subject: t.subject, html: t.html });
    } catch (err) {
      console.error("[signup] welcome email failed", err);
    }
    try {
      await notify({
        userId: user.id,
        type: "welcome",
        title: "Welcome to Sparkline Youth",
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
