"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redeemPass, getPassForUser, type RedeemResult } from "@/lib/founder-pass";
import {
  updatePassProfile,
  createFeedbackRequest,
  createRebuild,
  type UpdateProfileInput,
} from "@/lib/founder-pass-perks";
import { env } from "@/lib/env";
import { feedbackTopicLabel } from "@/lib/founder-pass-topics";
import { postStaffFeed } from "@/lib/chat-post";

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
  const supabase = await createClient();
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
  const fwd = (await headers()).get("x-forwarded-for");
  const ip = fwd ? fwd.split(",")[0].trim() : (await headers()).get("x-real-ip");

  const admin = createAdminClient();
  const result = await redeemPass(admin, {
    userId: user.id,
    rawCode,
    ip: ip ?? null,
  });

  if (!result.ok) {
    return { ok: false, message: MESSAGES[result.reason] };
  }

  revalidatePath("/pass");
  revalidatePath("/dashboard");
  return { ok: true, serial: result.serial };
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
  const supabase = await createClient();
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
  const supabase = await createClient();
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
      // Credits come from a founder pass or a scholarship award (0074), so
      // the honest "no" names both.
      no_pass: "You don't hold any feedback credits — they come with a founder pass or a scholarship.",
      // "One at a time" and "you're out" are genuinely different answers now
      // that a pass can carry more than one credit (migration 0055) — a
      // founding holder with one request in flight still has a credit left,
      // and telling them it's spent would be a lie.
      already_open:
        "You've got a feedback request open already. We'll reply to that one first.",
      spent:
        "You've used every feedback credit you hold. If you're mid-build and stuck, email us anyway.",
      invalid: "Pick what you'd like feedback on.",
      unavailable: "Feedback credits aren't available yet — try again shortly.",
    };
    return { ok: false, message: messages[result.reason] };
  }

  await postStaffFeed(
    `Feedback credit redeemed by **${await holderName(admin, user.id, user.email)}** on ${feedbackTopicLabel(input.topic)} · ${env.siteUrl}/admin/passes#requests`,
  );
  revalidatePath("/pass");
  return { ok: true };
}

/** A pass holder's name for the #staff line. */
async function holderName(admin: ReturnType<typeof createAdminClient>, userId: string, email?: string | null): Promise<string> {
  const { data } = await admin.from("profiles").select("full_name, email").eq("id", userId).maybeSingle();
  return (data as any)?.full_name || (data as any)?.email || email || "A pass holder";
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
  const supabase = await createClient();
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

  await postStaffFeed(
    `Seven-day rebuild submitted by **${await holderName(admin, user.id, user.email)}**: queued for one fresh review · ${env.siteUrl}/admin/applications`,
  );
  revalidatePath("/pass");
  revalidatePath("/dashboard/application");
  revalidatePath("/dashboard");
  return { ok: true };
}
