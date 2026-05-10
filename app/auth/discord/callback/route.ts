import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  exchangeOauthCode,
  fetchDiscordUser,
  addMemberToGuild,
  syncMemberRoles,
  getDiscordSettings,
} from "@/lib/discord";
import { env } from "@/lib/env";
import { logAudit } from "@/lib/audit";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

function back(reason: string, status: "ok" | "error" = "error") {
  const search = status === "ok" ? `?discord=linked` : `?discord_error=${reason}`;
  return NextResponse.redirect(
    new URL(`/dashboard/settings${search}`, env.siteUrl),
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) return back(errorParam);
  if (!code || !state) return back("missing_code");

  const [stateUserId, stateNonce] = state.split(":");
  const cookieNonce = req.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith("sparkline_discord_nonce="))
    ?.split("=")[1];
  if (!stateUserId || !stateNonce || stateNonce !== cookieNonce) {
    return back("bad_state");
  }

  // Confirm the same Supabase user is still in session — prevents
  // confused-deputy account hijack via stolen callback URL.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.id !== stateUserId) return back("not_signed_in");

  let tokens: Awaited<ReturnType<typeof exchangeOauthCode>>;
  let discordUser: Awaited<ReturnType<typeof fetchDiscordUser>>;
  try {
    tokens = await exchangeOauthCode(
      code,
      new URL("/auth/discord/callback", env.siteUrl).toString(),
    );
    discordUser = await fetchDiscordUser(tokens.access_token);
  } catch (err: any) {
    console.error("[discord] OAuth callback failed", err);
    return back("oauth_failed");
  }

  // Guard: refuse if this Discord account is already linked to someone
  // else. Surfaces a clear error rather than silently re-pointing.
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("profiles")
    .select("id")
    .eq("discord_user_id", discordUser.id)
    .neq("id", user.id)
    .maybeSingle();
  if (existing) return back("already_linked_to_another_account");

  // Persist the link.
  const { error: updateErr } = await admin
    .from("profiles")
    .update({
      discord_user_id: discordUser.id,
      discord_username: discordUser.global_name ?? discordUser.username,
      discord_avatar: discordUser.avatar,
      discord_linked_at: new Date().toISOString(),
    })
    .eq("id", user.id);
  if (updateErr) {
    console.error("[discord] profile update failed", updateErr);
    return back("save_failed");
  }

  // Best-effort: pull current role + drop them into the guild with the
  // role for that SparkLine role. The bot needs MANAGE_ROLES + the
  // role for the user must be below the bot's role.
  const { data: profile } = await admin
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .maybeSingle();

  const settings = await getDiscordSettings();
  const role = (profile?.role ?? "student") as Role;
  const targetRoleId = settings.roleIdByRole[role];
  await addMemberToGuild({
    discordUserId: discordUser.id,
    accessToken: tokens.access_token,
    roleIds: targetRoleId ? [targetRoleId] : [],
    nick: profile?.full_name ?? undefined,
  });
  // Reconcile in case they were already a member with stale roles.
  await syncMemberRoles(discordUser.id, role);

  await logAudit({
    action: "discord.linked",
    targetType: "profile",
    targetId: user.id,
    payload: { discord_user_id: discordUser.id, role },
  });

  return back("linked", "ok");
}
