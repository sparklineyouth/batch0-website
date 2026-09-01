import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

// Accept only same-origin relative paths so a tampered ?next= can't land the
// user somewhere else with a freshly-minted session. Mirrors safeNext() in
// app/auth/callback/route.ts.
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

// Only the types we actually mint links for. An open list would let a crafted
// URL exchange a token for a different kind of session than it was issued for.
const ALLOWED: ReadonlySet<string> = new Set(["recovery", "email"]);

/**
 * Verifies a one-time email token and turns it into a session cookie.
 *
 * This is the landing point for links *we* send — currently the password
 * reset (app/(auth)/forgot-password/actions.ts), which mints its token with
 * `auth.admin.generateLink` and mails it through Resend. Because we hold the
 * `token_hash` rather than a Supabase-hosted URL, the whole exchange happens
 * here on our own origin: no bounce through the Supabase domain, and no
 * dependence on whether the link comes back as a PKCE code or a URL fragment
 * (a fragment never reaches the server at all, which is the classic way this
 * flow silently fails).
 *
 * app/auth/callback/route.ts remains the landing point for OAuth and for the
 * signup confirmation, which arrive as `?code=`.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = safeNext(searchParams.get("next"));

  const invalid = `${origin}/forgot-password?error=${encodeURIComponent(
    "That link has expired or was already used. Request a new one.",
  )}`;

  if (!tokenHash || !type || !ALLOWED.has(type)) {
    return NextResponse.redirect(invalid);
  }

  const supabase = createClient();
  const { error } = await supabase.auth.verifyOtp({
    type: type as EmailOtpType,
    token_hash: tokenHash,
  });
  if (error) {
    console.error("[auth/confirm] verifyOtp failed:", error.message);
    return NextResponse.redirect(invalid);
  }

  // The session cookie is now set (createClient writes through next/headers),
  // so /reset loads with a live recovery session and updateUser() can set the
  // new password.
  return NextResponse.redirect(`${origin}${next}`);
}
