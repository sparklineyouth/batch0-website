"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { notify } from "@/lib/notifications";
import { checkRateLimit } from "@/lib/rate-limit";
import { postChannelMessage, getDiscordSettings } from "@/lib/discord";
import { env } from "@/lib/env";
import {
  getChallengeBySlug,
  buildAnswerSchema,
  isChallengeOpen,
  type ChallengeAnswers,
} from "@/lib/challenges";

export type ChallengeSubmitResult = {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  submissionId?: string;
};

/**
 * Submit a weekly-challenge application. Login required. Validates the
 * applicant's answers against the challenge's OWN dynamic question schema,
 * stores them keyed by question id alongside a frozen questions_snapshot, and
 * fans out best-effort notifications. Reuses the /apply machinery (rate limit,
 * confirmation email, admin notify, Discord feed).
 *
 * The form ships hidden `slug` + `referral_code` fields and one `q_<id>` field
 * per question.
 */
export async function submitChallengeApplication(
  _prev: ChallengeSubmitResult | null,
  formData: FormData,
): Promise<ChallengeSubmitResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in to apply." };

  const slug = String(formData.get("slug") ?? "").trim();
  if (!slug) return { ok: false, error: "Missing challenge." };

  const challenge = await getChallengeBySlug(slug);
  if (!challenge) return { ok: false, error: "This challenge no longer exists." };

  // Global kill switch (mirrors referrals_enabled).
  const { data: enabledSetting } = await supabase
    .from("site_settings")
    .select("value")
    .eq("key", "challenges_enabled")
    .maybeSingle();
  if (enabledSetting?.value === false) {
    return { ok: false, error: "Challenges are currently unavailable." };
  }

  if (!isChallengeOpen(challenge)) {
    return { ok: false, error: "This challenge is closed." };
  }

  // Throttle: 5 submit attempts / minute / user. Fail-open on DB trouble.
  const rl = await checkRateLimit({
    kind: "challenge-submit",
    identifier: user.id,
    limit: 5,
    windowSeconds: 60,
  });
  if (!rl.ok) {
    return { ok: false, error: "Too many attempts — wait a moment and retry." };
  }

  // Collect one answer per question (missing → ""), then validate against the
  // schema built from THIS challenge's questions.
  const rawAnswers: Record<string, string> = {};
  for (const q of challenge.questions) {
    rawAnswers[q.id] = String(formData.get(`q_${q.id}`) ?? "");
  }
  const parsed = buildAnswerSchema(challenge.questions).safeParse(rawAnswers);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString() ?? "_";
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return {
      ok: false,
      error: "Please fix the highlighted answers.",
      fieldErrors,
    };
  }
  const answers = parsed.data as ChallengeAnswers;

  const admin = createAdminClient();

  // One application per user per challenge.
  const { data: dupe } = await admin
    .from("challenge_submissions")
    .select("id")
    .eq("challenge_id", challenge.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (dupe) {
    return { ok: false, error: "You've already applied to this challenge." };
  }

  // Referral attribution — only when the feature is on (hard gate).
  let referralCode: string | null = null;
  const rawRef = String(formData.get("referral_code") ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 32);
  if (rawRef) {
    try {
      const { getSiteConfig } = await import("@/lib/site-config");
      const cfg = await getSiteConfig();
      if (cfg.settings.referralsEnabled) referralCode = rawRef;
    } catch {
      // ignore — attribution is non-critical
    }
  }

  // Insert as the signed-in user (RLS: user_id = auth.uid()).
  const { data: created, error } = await supabase
    .from("challenge_submissions")
    .insert({
      challenge_id: challenge.id,
      user_id: user.id,
      answers,
      questions_snapshot: challenge.questions,
      status: "submitted",
      referral_code: referralCode,
    })
    .select("id")
    .single();
  if (error) {
    // 23505 = unique_violation (raced the dupe check).
    if ((error as any).code === "23505") {
      return { ok: false, error: "You've already applied to this challenge." };
    }
    return { ok: false, error: error.message };
  }
  const submissionId = created!.id;

  // Best-effort post-submit fan-out — never affects the submit result.
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, email")
      .eq("id", user.id)
      .maybeSingle();

    const t = Templates.applicationReceived({ name: profile?.full_name ?? null });
    if (user.email) {
      await sendEmail({ to: user.email, subject: t.subject, html: t.html }).catch(
        (err) => {
          console.error("[challenge] applicant email threw", err);
          return { ok: false as const, reason: "threw" };
        },
      );
    }

    await notify({
      userId: user.id,
      type: "challenge_submitted",
      title: "Challenge application submitted",
      body: `We got your application for "${challenge.title}". We review funding weekly.`,
      link: "/dashboard",
    });

    const { data: admins } = await admin
      .from("profiles")
      .select("id")
      .eq("role", "admin");
    for (const a of admins ?? []) {
      await notify({
        userId: a.id,
        type: "admin_new_challenge_submission",
        title: "New challenge application",
        body: `${profile?.full_name ?? profile?.email ?? "Someone"} applied to "${challenge.title}".`,
        link: `/admin/challenges/${challenge.id}/submissions/${submissionId}`,
      });
    }

    try {
      const settings = await getDiscordSettings();
      if (settings.adminFeedChannelId) {
        await postChannelMessage(settings.adminFeedChannelId, {
          content: `🏆 New **${challenge.title}** application from ${
            profile?.full_name ?? user.email ?? "an applicant"
          } — ${env.siteUrl}/admin/challenges/${challenge.id}/submissions/${submissionId}`,
        });
      }
    } catch (err) {
      console.error("[challenge] discord cross-post failed", err);
    }
  } catch (err) {
    console.error("[challenge] post-submit notifications failed", err);
  }

  revalidatePath("/dashboard");
  revalidatePath("/admin/challenges");
  revalidatePath(`/admin/challenges/${challenge.id}`);
  revalidatePath(`/admin/challenges/${challenge.id}/submissions`);

  return { ok: true, submissionId };
}
