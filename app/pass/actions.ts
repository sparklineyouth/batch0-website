"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redeemPass, getPassForUser, type RedeemResult } from "@/lib/founder-pass";
import {
  grantFounderPassRole,
  getDiscordSettings,
  postChannelMessage,
  announcementEmbed,
} from "@/lib/discord";
import {
  updatePassProfile,
  createFeedbackRequest,
  createRebuild,
  feedbackTopicLabel,
  type UpdateProfileInput,
} from "@/lib/founder-pass-perks";
import { env } from "@/lib/env";

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

// Ping the admin Discord feed about a new holder request (feedback credit /
// rebuild). Best-effort, exactly like the accept announcement in
// app/admin/applications/[id]/actions.ts — a Discord hiccup must never fail the
// student's submission, which has already committed.
async function pingAdminFeed(title: string, body: string, link: string) {
  try {
    const settings = await getDiscordSettings();
    if (!settings.adminFeedChannelId) return;
    await postChannelMessage(settings.adminFeedChannelId, {
      embeds: [announcementEmbed({ title, body, link })],
    });
  } catch (err) {
    console.error("[founder-pass] admin feed ping failed", err);
  }
}

// ---------------------------------------------------------------------------
// Public founder profile (perk 9)
// ---------------------------------------------------------------------------
export type ProfileActionResult =
  | { ok: true }
  | { ok: false; message: string };

export async function updatePassProfileAction(
  input: UpdateProfileInput,
): Promise<ProfileActionResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Sign in to edit your profile." };

  const result = await updatePassProfile(createAdminClient(), user.id, input);
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "no_pass"
          ? "You don't hold a live founder pass."
          : "Profiles aren't available yet — try again shortly.",
    };
  }

  revalidatePath("/pass");
  // The public page keys off the serial; revalidate it so a publish/unpublish
  // shows up immediately for anyone holding the link.
  const pass = await getPassForUser(createAdminClient(), user.id);
  if (pass) revalidatePath(`/pass/${pass.serial}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Feedback credit (perk 5)
// ---------------------------------------------------------------------------
export type FeedbackActionResult =
  | { ok: true }
  | { ok: false; message: string };

export async function redeemFeedbackCreditAction(input: {
  topic: string;
  detail: string;
  linkUrl?: string | null;
}): Promise<FeedbackActionResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Sign in to redeem your credit." };

  const admin = createAdminClient();
  const result = await createFeedbackRequest(admin, {
    userId: user.id,
    topic: input.topic,
    detail: input.detail,
    linkUrl: input.linkUrl ?? null,
  });

  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      no_pass: "You don't hold a live founder pass.",
      already_open:
        "You've already redeemed your feedback credit. Watch this space for the team's reply.",
      invalid: "Pick what you'd like feedback on.",
      unavailable: "Feedback credits aren't available yet — try again shortly.",
    };
    return { ok: false, message: messages[result.reason] };
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("full_name, email")
    .eq("id", user.id)
    .maybeSingle();
  const who =
    (profile as any)?.full_name || (profile as any)?.email || "A pass holder";
  await pingAdminFeed(
    `Feedback credit redeemed: ${who}`,
    `On: ${feedbackTopicLabel(input.topic)}`,
    `${env.siteUrl}/admin/pass-requests`,
  );

  revalidatePath("/pass");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Seven-day rebuild (perk 4)
// ---------------------------------------------------------------------------
export type RebuildActionResult =
  | { ok: true }
  | { ok: false; message: string };

export async function submitRebuildAction(input: {
  summary: string;
  linkUrl?: string | null;
}): Promise<RebuildActionResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Sign in to submit your build." };

  const admin = createAdminClient();
  const result = await createRebuild(admin, {
    userId: user.id,
    summary: input.summary,
    linkUrl: input.linkUrl ?? null,
  });

  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      no_pass: "You don't hold a live founder pass.",
      not_declined:
        "The rebuild is for pass holders whose last application was declined.",
      already_submitted:
        "You've already submitted your rebuild — it's queued for a fresh review.",
      invalid: "Tell us a bit more about what you built and learned (a few sentences).",
      unavailable: "The rebuild isn't available yet — try again shortly.",
    };
    return { ok: false, message: messages[result.reason] };
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("full_name, email")
    .eq("id", user.id)
    .maybeSingle();
  const who =
    (profile as any)?.full_name || (profile as any)?.email || "A pass holder";
  await pingAdminFeed(
    `Seven-day rebuild submitted: ${who}`,
    "Their application is queued for one fresh review.",
    `${env.siteUrl}/admin/applications`,
  );

  revalidatePath("/pass");
  revalidatePath("/dashboard/application");
  revalidatePath("/dashboard");
  return { ok: true };
}
