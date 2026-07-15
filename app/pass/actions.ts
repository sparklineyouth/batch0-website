"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redeemPass, type RedeemResult } from "@/lib/founder-pass";
import { grantFounderPassRole } from "@/lib/discord";

export type RedeemActionResult =
  | { ok: true; serial: number }
  | { ok: false; message: string };

// One message per failure reason. Written to be read by someone standing
// there holding a card, so each one says what to actually do next rather
// than restating the error.
const MESSAGES: Record<Exclude<RedeemResult, { ok: true }>["reason"], string> = {
  invalid:
    "That code didn't match a pass. Check for typos — letters and spacing don't matter, but every character does.",
  already_redeemed:
    "That pass has already been claimed by another account. If that wasn't you, email hello@batch0.org and we'll sort it out.",
  revoked:
    "That pass has been deactivated. If you think that's a mistake, email hello@batch0.org.",
  already_have_pass:
    "This account already holds a founder pass. Each account can hold one — pass your spare card to someone else.",
  rate_limited:
    "Too many attempts. Wait an hour and try again, or email hello@batch0.org if you're stuck.",
};

/**
 * Redeem a founder pass code for the signed-in user.
 *
 * Requires auth: the pass binds a physical card to exactly one account, so
 * there is nothing sensible to do with a code from an anonymous visitor. The
 * form handles the signed-out case by stashing the code and routing through
 * signup (see lib/pass-code.ts).
 */
export async function redeemPassAction(
  rawCode: string,
): Promise<RedeemActionResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, message: "Sign in to redeem your pass." };
  }

  // Mirrors lib/rate-limit.ts clientIp(), which takes a Request; server
  // actions get headers() instead. x-forwarded-for is a client-settable
  // header, so this is a spend-more-effort speed bump, not an identity —
  // which is why the per-account limit exists alongside it.
  const fwd = headers().get("x-forwarded-for");
  const ip = fwd ? fwd.split(",")[0].trim() : headers().get("x-real-ip");

  const admin = createAdminClient();
  const result = await redeemPass(admin, {
    userId: user.id,
    rawCode,
    ip: ip ?? null,
  });

  if (!result.ok) {
    return { ok: false, message: MESSAGES[result.reason] };
  }

  // Perks that live outside our database are granted best-effort. A Discord
  // outage, an unlinked account, or an unset role ID must never fail a
  // redemption that already committed — the pass is redeemed, and the role is
  // reconcilable later (the admin resync path and /sync both re-run this).
  try {
    const { data: profile } = await admin
      .from("profiles")
      .select("discord_user_id")
      .eq("id", user.id)
      .maybeSingle();
    await grantFounderPassRole(
      (profile as { discord_user_id: string | null } | null)?.discord_user_id,
    );
  } catch (err) {
    console.error("[founder-pass] discord role grant failed", err);
  }

  revalidatePath("/pass");
  revalidatePath("/dashboard");
  return { ok: true, serial: result.serial };
}
