import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  removeRoleFromMember,
  getDiscordSettings,
  postChannelMessage,
  announcementEmbed,
} from "@/lib/discord";
import { logAudit } from "@/lib/audit";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const SETTINGS = "/dashboard/settings";

/**
 * Every exit from this route lands the user back on Settings with a message
 * the page knows how to render (see ERROR_COPY there).
 *
 * The origin comes from the request, never `env.siteUrl`. That variable
 * defaults to a hardcoded string and is otherwise whatever someone typed into
 * Vercel — a missing scheme makes `new URL()` throw ERR_INVALID_URL, and this
 * route used to build its one redirect that way. A malformed env var turning
 * "unlink" into an unstyled 500 is exactly the failure this route should not
 * have. It also keeps apex and www visitors on the host they came from.
 *
 * 303 forces the browser to follow with GET. Without it a POST redirect is
 * re-issued as a POST to Settings, which is a page, not a handler.
 */
function resolveOrigin(req: Request): string {
  try {
    return new URL(req.url).origin;
  } catch {
    // Belt and braces. `req.url` is always absolute in a route handler, but
    // this is what the outer catch below depends on to report failure — if it
    // could throw, the one path guaranteed to render a clean screen would be
    // the one path that couldn't.
    return env.siteUrl.startsWith("http") ? env.siteUrl : "https://batch0.org";
  }
}

function backTo(origin: string) {
  return (search: string) =>
    NextResponse.redirect(`${origin}${SETTINGS}${search}`, 303);
}

/**
 * Drops the Discord link off the user's profile and revokes any
 * batch0-managed roles they had. Doesn't kick them from the
 * server — staff might still want them around.
 *
 * The ordering is deliberate: Discord cleanup runs first but is *advisory*,
 * and clearing our own columns is what actually defines "unlinked". If Discord
 * is unreachable, rate-limiting us, or has been disabled since the link was
 * made, the user still gets unlinked here and we say so plainly, rather than
 * failing the whole operation over a side effect on someone else's server.
 * The reverse — clearing roles but keeping the columns — would leave a profile
 * claiming a link that no longer grants anything, which nothing reconciles.
 */
export async function POST(req: Request) {
  const origin = resolveOrigin(req);
  const back = backTo(origin);
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      // Was a raw 401 JSON body. A signed-out session here is ordinary — the
      // Settings tab sat open past the token's expiry and the form still
      // posted — so it belongs in the login funnel, not on a page of JSON.
      return NextResponse.redirect(
        `${origin}/login?next=${encodeURIComponent(SETTINGS)}`,
        303,
      );
    }

    const admin = createAdminClient();
    const { data: profile, error: readErr } = await admin
      .from("profiles")
      .select("discord_user_id, full_name, email")
      .eq("id", user.id)
      .maybeSingle();
    if (readErr) {
      console.error("[discord] unlink: profile read failed", readErr);
      return back("?discord_error=unlink_failed");
    }

    // Already unlinked. Idempotent by design: double-submits and a browser
    // replaying the POST both land here, and "you are not linked" is the state
    // the user asked for. Previously returned `{"ok":true}` as a JSON body,
    // which rendered as literal text in the tab they were sitting in.
    if (!profile?.discord_user_id) {
      return back("?discord=unlinked");
    }

    const discordUserId = profile.discord_user_id;

    // Best-effort role revocation. The individual helpers already swallow
    // their own fetch failures and return false, but getDiscordSettings()
    // does not — it is a bare Supabase read, and a failure there used to
    // throw straight out of this handler, past the profile update below. So
    // the user got an error page AND stayed linked.
    let cleanupOk = true;
    // Nothing to revoke when the bot isn't configured or the integration is
    // switched off — the roles were never granted from here. This gate is what
    // keeps `cleanupOk` honest: every helper below returns `false` in those
    // states, indistinguishable from a rejected call, so without it a
    // perfectly clean unlink on a Discord-less deploy would warn the user that
    // something didn't finish.
    const configured = Boolean(env.discordBotToken && env.discordGuildId);
    if (configured) {
      try {
        const settings = await getDiscordSettings();
        if (settings.enabled) {
          const roleIds = Object.values(settings.roleIdByRole).filter(
            (rid): rid is string => Boolean(rid),
          );
          const results = await Promise.all(
            roleIds.map((rid) => removeRoleFromMember(discordUserId, rid)),
          );
          cleanupOk = results.every(Boolean);

          if (settings.adminFeedChannelId) {
            await postChannelMessage(settings.adminFeedChannelId, {
              embeds: [
                announcementEmbed({
                  title: `🔌 Unlinked: ${profile.full_name ?? profile.email ?? "user"}`,
                  body: `Removed batch0-managed roles from <@${discordUserId}>.`,
                }),
              ],
            });
          }
        }
      } catch (err) {
        console.error("[discord] unlink: role cleanup failed", err);
        cleanupOk = false;
      }
    }

    // The authoritative step. Its failure is the only one that means the
    // unlink did not happen, so it is the only one that reports an error.
    const { error: updateErr } = await admin
      .from("profiles")
      .update({
        discord_user_id: null,
        discord_username: null,
        discord_avatar: null,
        discord_linked_at: null,
      })
      .eq("id", user.id);
    if (updateErr) {
      console.error("[discord] unlink: profile update failed", updateErr);
      return back("?discord_error=unlink_failed");
    }

    await logAudit({
      action: "discord.unlinked",
      targetType: "profile",
      targetId: user.id,
      payload: { discord_user_id: discordUserId, roles_revoked: cleanupOk },
    });

    return back(cleanupOk ? "?discord=unlinked" : "?discord=unlinked_partial");
  } catch (err) {
    // Nothing below the guards is expected to throw, but this route's whole
    // job is to end cleanly — an unhandled throw here is the raw error page
    // the user asked us not to show them.
    console.error("[discord] unlink failed", err);
    return back("?discord_error=unlink_failed");
  }
}

/**
 * Unlink is a POST — a GET here means a bookmark, a prefetch, a shared URL, or
 * someone poking at the address bar. Any of those returned Next's bare 405
 * before this existed. Bounce to Settings instead; the form is right there.
 *
 * It must NOT unlink. A GET that mutates is triggerable by any <img> tag on
 * any page the user visits.
 */
export async function GET(req: Request) {
  return backTo(resolveOrigin(req))("");
}
