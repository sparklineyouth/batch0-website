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
  HTTP_URL_RE,
  CHALLENGE_UPLOAD_BUCKET,
  CHALLENGE_UPLOAD_PREFIX,
  CHALLENGE_EXTRA_VIDEO_KEY,
  type ChallengeAnswers,
  type ChallengeQuestion,
} from "@/lib/challenges";

export type ChallengeSubmitResult = {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  submissionId?: string;
};

/** Filesystem-safe path segment (mirrors the team-drive upload helper). */
function safeSegment(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// The private challenge-uploads bucket is normally created by migration 0047,
// but we self-heal here so the feature works on any deploy without a manual
// migration step. Cached per warm instance so we only probe once.
let bucketReady: Promise<void> | null = null;
function ensureChallengeUploadBucket(
  admin: ReturnType<typeof createAdminClient>,
): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const { error } = await admin.storage.createBucket(
        CHALLENGE_UPLOAD_BUCKET,
        {
          public: false,
          allowedMimeTypes: ["video/mp4"],
          fileSizeLimit: 209715200, // 200 MB, matches the client-side cap
        },
      );
      // A "already exists" error is the expected happy path once created.
      if (
        error &&
        !/exist/i.test(error.message) &&
        !("statusCode" in error && (error as any).statusCode === "409")
      ) {
        bucketReady = null; // let a later call retry a genuine failure
        throw new Error(error.message);
      }
    })();
  }
  return bucketReady;
}

export type ChallengeUploadToken = {
  ok: boolean;
  error?: string;
  path?: string;
  token?: string;
  bucket?: string;
};

/**
 * Mint a one-shot signed upload URL for a challenge video. The applicant's
 * browser uploads the file straight to the private `challenge-uploads` bucket
 * via `uploadToSignedUrl`, which sidesteps the ~1 MB server-action body limit
 * that would otherwise make video uploads impossible. The signed URL is what
 * authorizes the write, so the bucket needs no broad INSERT policy — same
 * pattern as `getTeamDriveUploadToken`.
 *
 * Gated to signed-in users applying to an OPEN challenge, so tokens can't be
 * minted for closed/nonexistent challenges or by anonymous callers.
 */
export async function getChallengeUploadToken(input: {
  slug: string;
  filename: string;
}): Promise<ChallengeUploadToken> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in to upload." };

  const slug = String(input.slug ?? "").trim();
  if (!slug) return { ok: false, error: "Missing challenge." };

  const challenge = await getChallengeBySlug(slug);
  if (!challenge) return { ok: false, error: "This challenge no longer exists." };

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

  const dot = input.filename.lastIndexOf(".");
  const base = dot > 0 ? input.filename.slice(0, dot) : input.filename;
  const ext = dot > 0 ? input.filename.slice(dot + 1) : "mp4";
  const path = `${challenge.id}/${user.id}/${Date.now()}-${safeSegment(base)}.${safeSegment(ext)}`;

  const admin = createAdminClient();
  try {
    await ensureChallengeUploadBucket(admin);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Storage isn't ready yet." };
  }
  const { data, error } = await admin.storage
    .from(CHALLENGE_UPLOAD_BUCKET)
    .createSignedUploadUrl(path);
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    path: data.path,
    token: data.token,
    bucket: CHALLENGE_UPLOAD_BUCKET,
  };
}

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

  // Standalone "Demo video" field — offered on every form, so it isn't part of
  // the challenge's questions. Accept a pasted link or an `upload:<path>`, then
  // mirror a synthetic `video` question into the snapshot so the admin review
  // page renders it with no special-casing.
  let questionsSnapshot: ChallengeQuestion[] = challenge.questions;
  const extraVideo = String(formData.get("extra_video") ?? "")
    .trim()
    .slice(0, 500);
  if (
    extraVideo &&
    (HTTP_URL_RE.test(extraVideo) ||
      extraVideo.startsWith(CHALLENGE_UPLOAD_PREFIX))
  ) {
    answers[CHALLENGE_EXTRA_VIDEO_KEY] = extraVideo;
    questionsSnapshot = [
      ...challenge.questions,
      {
        id: CHALLENGE_EXTRA_VIDEO_KEY,
        type: "video",
        label: "Demo video",
        help: "",
        placeholder: "",
        required: false,
        options: [],
      },
    ];
  }

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
      questions_snapshot: questionsSnapshot,
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
