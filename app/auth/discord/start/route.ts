import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isDiscordEnabled } from "@/lib/discord";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Begin the Discord OAuth flow. We bounce the user over to Discord
 * with `identify` + `guilds.join` scopes — the latter lets the bot
 * auto-add them to our server in the callback. We stash the user's
 * Supabase ID in `state` (signed-ish via random nonce + cookie) so the
 * callback can re-tie the link to the right account.
 */
export async function GET(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(
      new URL("/login?next=/auth/discord/start", req.url),
    );
  }
  if (!env.discordClientId) {
    return NextResponse.redirect(
      new URL("/dashboard/settings?discord_error=not_configured", req.url),
    );
  }
  if (!(await isDiscordEnabled())) {
    return NextResponse.redirect(
      new URL("/dashboard/settings?discord_error=disabled", req.url),
    );
  }

  const nonce = crypto.randomUUID();
  const redirectUri = new URL("/auth/discord/callback", env.siteUrl).toString();
  const state = `${user.id}:${nonce}`;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.discordClientId,
    scope: "identify guilds.join",
    redirect_uri: redirectUri,
    state,
    prompt: "consent",
  });

  const res = NextResponse.redirect(
    `https://discord.com/api/oauth2/authorize?${params}`,
  );
  res.cookies.set("sparkline_discord_nonce", nonce, {
    httpOnly: true,
    // secure: true would drop the cookie on http://localhost in dev,
    // breaking the OAuth round-trip — gate on NODE_ENV.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
