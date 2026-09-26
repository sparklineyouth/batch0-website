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
  getReferralProgress,
  challengeWindowState,
  canRegister,
  validateAnswers,
  extensionsFor,
  fileExtension,
  KIND_LABELS,
  CHALLENGE_UPLOAD_BUCKET,
  VIDEO_EXTENSIONS,
  MAX_VIDEO_BYTES,
  MAX_FILE_BYTES,
  type Challenge,
  type ReferralProgress,
} from "@/lib/challenges";

// ---------------------------------------------------------------------------
// Entrant actions: register → draft (autosave) → submit.
//
// Every write goes through the service-role client AFTER the checks here —
// there is no RLS insert path for registrations or submissions (0085), because
// both carry things a client must not choose for itself: referral attribution,
// status, and which uploaded files belong to whom.
// ---------------------------------------------------------------------------

type Ctx = {
  userId: string;
  email: string | null;
  challenge: Challenge;
  admin: ReturnType<typeof createAdminClient>;
};

async function loadContext(
  slug: string,
): Promise<{ ok: true; ctx: Ctx } | { ok: false; error: string; signIn?: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first.", signIn: true };

  const cleanSlug = String(slug ?? "").trim();
  if (!cleanSlug) return { ok: false, error: "Missing challenge." };
  const challenge = await getChallengeBySlug(cleanSlug);
  if (!challenge) return { ok: false, error: "This challenge no longer exists." };

  const admin = createAdminClient();
  // Global kill switch (mirrors referrals_enabled).
  const { data: enabled } = await admin
    .from("site_settings")
    .select("value")
    .eq("key", "challenges_enabled")
    .maybeSingle();
  if (enabled?.value === false) {
    return { ok: false, error: "Challenges are paused right now." };
  }
  return {
    ok: true,
    ctx: { userId: user.id, email: user.email ?? null, challenge, admin },
  };
}

/** Clean a client-supplied referral code: lowercase, [a-z0-9], ≤32 chars. */
function cleanRef(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);
}

/**
 * Resolve the referral code to store on a registration: only a real code that
 * isn't the registrant's own, and only when referrals are on (globally, or
 * because this challenge requires them).
 */
async function attributableRef(ctx: Ctx, raw: unknown): Promise<string | null> {
  const code = cleanRef(raw);
  if (!code) return null;
  const { data: owner } = await ctx.admin
    .from("profiles")
    .select("id")
    .eq("referral_code", code)
    .maybeSingle();
  if (!owner || owner.id === ctx.userId) return null;
  if (ctx.challenge.referralsRequired > 0) return code;
  try {
    const { getSiteConfig } = await import("@/lib/site-config");
    const cfg = await getSiteConfig();
    return cfg.settings.referralsEnabled ? code : null;
  } catch {
    return null;
  }
}

function pageUrl(slug: string) {
  return `${env.siteUrl}/challenges/${slug}`;
}

/**
 * Create the registration row if it doesn't exist. Returns true when THIS call
 * created it (so the welcome email goes out exactly once).
 */
async function ensureRegistration(ctx: Ctx, refRaw: unknown): Promise<boolean> {
  const { data: existing } = await ctx.admin
    .from("challenge_registrations")
    .select("id")
    .eq("challenge_id", ctx.challenge.id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (existing) return false;

  const referral_code = await attributableRef(ctx, refRaw);
  const { error } = await ctx.admin.from("challenge_registrations").insert({
    challenge_id: ctx.challenge.id,
    user_id: ctx.userId,
    referral_code,
  });
  if (error) {
    // 23505 = raced another tab; they're registered either way.
    if ((error as any).code === "23505") return false;
    throw new Error(error.message);
  }

  // Best-effort welcome — never blocks registering.
  try {
    const { data: profile } = await ctx.admin
      .from("profiles")
      .select("full_name")
      .eq("id", ctx.userId)
      .maybeSingle();
    const c = ctx.challenge;
    if (ctx.email) {
      const t = Templates.challengeRegistered({
        name: profile?.full_name ?? null,
        title: c.title,
        kindLabel: KIND_LABELS[c.kind],
        pageUrl: pageUrl(c.slug),
        submitUrl: `${pageUrl(c.slug)}/submit`,
        opensAt: c.opensAt,
        closesAt: c.closesAt,
        referralsRequired: c.referralsRequired,
      });
      await sendEmail({
        to: ctx.email,
        subject: t.subject,
        html: t.html,
        templateKey: "challenge.registered",
      }).catch(() => null);
    }
    await notify({
      userId: ctx.userId,
      type: "challenge_registered",
      title: `You're registered for ${c.title}`,
      body: c.closesAt
        ? `Submissions are due ${new Date(c.closesAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}.`
        : "Submit your project whenever you're ready.",
      link: `/challenges/${c.slug}`,
    });
  } catch (err) {
    console.error("[challenge] registration fan-out failed", err);
  }
  revalidatePath("/challenges");
  revalidatePath(`/admin/challenges/${ctx.challenge.id}/registrations`);
  return true;
}

export type RegisterResult = {
  ok: boolean;
  error?: string;
  signIn?: boolean;
  created?: boolean;
};

/** One-click registration. Idempotent. */
export async function registerForChallenge(input: {
  slug: string;
  refCode?: string | null;
}): Promise<RegisterResult> {
  const loaded = await loadContext(input.slug);
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  if (!canRegister(ctx.challenge)) {
    return { ok: false, error: "Registration for this one has closed." };
  }
  const rl = await checkRateLimit({
    kind: "challenge-register",
    identifier: ctx.userId,
    limit: 10,
    windowSeconds: 60,
  });
  if (!rl.ok) return { ok: false, error: "Slow down a sec and try again." };
  try {
    const created = await ensureRegistration(ctx, input.refCode);
    return { ok: true, created };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Couldn't register you." };
  }
}

/** The folder a user's uploads for a challenge live under. Files outside it
 *  are dropped from answers by validateAnswers. */
function uploadPrefix(ctx: Ctx) {
  return `${ctx.challenge.id}/${ctx.userId}/`;
}

export type DraftResult = {
  ok: boolean;
  error?: string;
  savedAt?: string;
  alreadySubmitted?: boolean;
};

/**
 * Autosave. Keeps whatever the entrant has typed so far — no required checks —
 * and registers them if they weren't. Only touches a DRAFT: once an entry is
 * submitted, changes go through submitChallengeEntry so they're re-validated.
 */
export async function saveChallengeDraft(input: {
  slug: string;
  answers: Record<string, unknown>;
  refCode?: string | null;
}): Promise<DraftResult> {
  const loaded = await loadContext(input.slug);
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  if (!canRegister(ctx.challenge)) {
    return { ok: false, error: "This challenge has closed." };
  }
  const rl = await checkRateLimit({
    kind: "challenge-draft",
    identifier: ctx.userId,
    limit: 60,
    windowSeconds: 60,
  });
  if (!rl.ok) return { ok: false, error: "Saving too fast — pausing autosave." };

  const { data: existing } = await ctx.admin
    .from("challenge_submissions")
    .select("id, status")
    .eq("challenge_id", ctx.challenge.id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (existing && existing.status !== "draft") {
    return { ok: false, alreadySubmitted: true };
  }

  const { answers } = validateAnswers(ctx.challenge.questions, input.answers ?? {}, {
    mode: "draft",
    uploadPrefix: uploadPrefix(ctx),
  });

  try {
    await ensureRegistration(ctx, input.refCode);
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Couldn't save." };
  }

  const now = new Date().toISOString();
  if (existing) {
    const { error } = await ctx.admin
      .from("challenge_submissions")
      .update({ answers, questions_snapshot: ctx.challenge.questions })
      .eq("id", existing.id)
      .eq("status", "draft");
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await ctx.admin.from("challenge_submissions").insert({
      challenge_id: ctx.challenge.id,
      user_id: ctx.userId,
      answers,
      questions_snapshot: ctx.challenge.questions,
      status: "draft",
    });
    // A concurrent autosave from another tab won the insert — fine.
    if (error && (error as any).code !== "23505") {
      return { ok: false, error: error.message };
    }
  }
  return { ok: true, savedAt: now };
}

export type SubmitResult = {
  ok: boolean;
  error?: string;
  signIn?: boolean;
  fieldErrors?: Record<string, string>;
  referral?: ReferralProgress;
  edited?: boolean;
};

/**
 * Submit (or, when edits are allowed, re-submit) an entry. Validates against
 * the challenge's own questions, enforces the referral gate on the FIRST
 * submit, and fans out notifications once.
 */
export async function submitChallengeEntry(input: {
  slug: string;
  answers: Record<string, unknown>;
  refCode?: string | null;
}): Promise<SubmitResult> {
  const loaded = await loadContext(input.slug);
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  const c = ctx.challenge;

  const windowState = challengeWindowState(c);
  if (windowState !== "open") {
    return {
      ok: false,
      error:
        windowState === "upcoming"
          ? "Submissions haven't opened yet — your draft is saved."
          : "Submissions for this one have closed.",
    };
  }

  const rl = await checkRateLimit({
    kind: "challenge-submit",
    identifier: ctx.userId,
    limit: 8,
    windowSeconds: 60,
  });
  if (!rl.ok) return { ok: false, error: "Too many attempts — wait a moment." };

  const { data: existing } = await ctx.admin
    .from("challenge_submissions")
    .select("id, status, submitted_at")
    .eq("challenge_id", c.id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  const alreadySubmitted = !!existing && existing.status !== "draft";
  if (alreadySubmitted) {
    if (existing!.status !== "submitted") {
      return {
        ok: false,
        error: "Your entry has already been reviewed, so it's locked.",
      };
    }
    if (!c.allowEdits) {
      return { ok: false, error: "Entries can't be edited once submitted." };
    }
  }

  const { answers, errors } = validateAnswers(c.questions, input.answers ?? {}, {
    mode: "submit",
    uploadPrefix: uploadPrefix(ctx),
  });
  if (Object.keys(errors).length) {
    return {
      ok: false,
      error: "A few answers need another look.",
      fieldErrors: errors,
    };
  }

  // Referral gate — first submit only. Someone editing an accepted entry
  // already cleared it.
  if (!alreadySubmitted && c.referralsRequired > 0) {
    const { data: profile } = await ctx.admin
      .from("profiles")
      .select("referral_code")
      .eq("id", ctx.userId)
      .maybeSingle();
    const progress = await getReferralProgress(
      c,
      ctx.userId,
      (profile as any)?.referral_code ?? null,
      ctx.admin,
    );
    if (progress.count < c.referralsRequired) {
      const left = c.referralsRequired - progress.count;
      return {
        ok: false,
        error: `Almost there — refer ${left} more friend${left === 1 ? "" : "s"} to unlock submitting. Your answers are saved.`,
        referral: progress,
      };
    }
  }

  try {
    await ensureRegistration(ctx, input.refCode);
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Couldn't submit." };
  }

  const now = new Date().toISOString();
  let submissionId: string;
  if (existing) {
    const { error } = await ctx.admin
      .from("challenge_submissions")
      .update({
        answers,
        questions_snapshot: c.questions,
        status: "submitted",
        submitted_at: existing.submitted_at ?? now,
      })
      .eq("id", existing.id)
      .in("status", ["draft", "submitted"]);
    if (error) return { ok: false, error: error.message };
    submissionId = existing.id;
  } else {
    const referralCode = await attributableRef(ctx, input.refCode);
    const { data: created, error } = await ctx.admin
      .from("challenge_submissions")
      .insert({
        challenge_id: c.id,
        user_id: ctx.userId,
        answers,
        questions_snapshot: c.questions,
        status: "submitted",
        submitted_at: now,
        referral_code: referralCode,
      })
      .select("id")
      .single();
    if (error) {
      if ((error as any).code === "23505") {
        return { ok: false, error: "Looks like this was submitted from another tab — reload to see it." };
      }
      return { ok: false, error: error.message };
    }
    submissionId = created!.id;
  }

  if (!alreadySubmitted) {
    await fanOutSubmitted(ctx, submissionId);
  }

  revalidatePath("/dashboard");
  revalidatePath("/admin/challenges");
  revalidatePath(`/admin/challenges/${c.id}/submissions`);
  return { ok: true, edited: alreadySubmitted };
}

/** Best-effort post-submit fan-out — never affects the submit result. */
async function fanOutSubmitted(ctx: Ctx, submissionId: string) {
  const c = ctx.challenge;
  try {
    const { data: profile } = await ctx.admin
      .from("profiles")
      .select("full_name, email")
      .eq("id", ctx.userId)
      .maybeSingle();

    if (ctx.email) {
      const t = Templates.challengeSubmitted({
        name: profile?.full_name ?? null,
        title: c.title,
        pageUrl: pageUrl(c.slug),
        submitUrl: `${pageUrl(c.slug)}/submit`,
        editableUntil: c.allowEdits ? c.closesAt : null,
        resultsAt: c.resultsAt,
      });
      await sendEmail({
        to: ctx.email,
        subject: t.subject,
        html: t.html,
        templateKey: "challenge.submitted",
      }).catch(() => null);
    }

    await notify({
      userId: ctx.userId,
      type: "challenge_submitted",
      title: `Submitted to ${c.title}`,
      body: c.allowEdits
        ? "You can keep editing until the deadline."
        : "We'll let you know when winners are picked.",
      link: `/challenges/${c.slug}`,
    });

    const { data: admins } = await ctx.admin
      .from("profiles")
      .select("id")
      .eq("role", "admin");
    for (const a of admins ?? []) {
      await notify({
        userId: a.id,
        type: "admin_new_challenge_submission",
        title: "New challenge submission",
        body: `${profile?.full_name ?? profile?.email ?? "Someone"} submitted to "${c.title}".`,
        link: `/admin/challenges/${c.id}/submissions/${submissionId}`,
      });
    }

    try {
      const settings = await getDiscordSettings();
      if (settings.adminFeedChannelId) {
        await postChannelMessage(settings.adminFeedChannelId, {
          content: `🏆 New **${c.title}** submission from ${
            profile?.full_name ?? ctx.email ?? "an entrant"
          } — ${env.siteUrl}/admin/challenges/${c.id}/submissions/${submissionId}`,
        });
      }
    } catch (err) {
      console.error("[challenge] discord cross-post failed", err);
    }
  } catch (err) {
    console.error("[challenge] post-submit notifications failed", err);
  }
}

/** Current referral standing, for the gate panel's Refresh button. */
export async function refreshReferralProgress(input: {
  slug: string;
}): Promise<{ ok: boolean; error?: string; progress?: ReferralProgress }> {
  const loaded = await loadContext(input.slug);
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  const rl = await checkRateLimit({
    kind: "challenge-referral-refresh",
    identifier: ctx.userId,
    limit: 20,
    windowSeconds: 60,
  });
  if (!rl.ok) return { ok: false, error: "Give it a few seconds." };
  const { data: profile } = await ctx.admin
    .from("profiles")
    .select("referral_code")
    .eq("id", ctx.userId)
    .maybeSingle();
  const progress = await getReferralProgress(
    ctx.challenge,
    ctx.userId,
    (profile as any)?.referral_code ?? null,
    ctx.admin,
  );
  return { ok: true, progress };
}

/** Filesystem-safe path segment. */
function safeSegment(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "file";
}

// The private challenge-uploads bucket is created by migrations 0047/0085;
// self-heal here so uploads work on a deploy whose migration hasn't run.
let bucketReady: Promise<void> | null = null;
function ensureUploadBucket(admin: ReturnType<typeof createAdminClient>) {
  if (!bucketReady) {
    bucketReady = (async () => {
      const { error } = await admin.storage.createBucket(CHALLENGE_UPLOAD_BUCKET, {
        public: false,
        fileSizeLimit: MAX_VIDEO_BYTES,
      });
      if (
        error &&
        !/exist/i.test(error.message) &&
        !("statusCode" in error && (error as any).statusCode === "409")
      ) {
        bucketReady = null;
        throw new Error(error.message);
      }
    })();
  }
  return bucketReady;
}

export type UploadToken = {
  ok: boolean;
  error?: string;
  path?: string;
  token?: string;
  bucket?: string;
};

/**
 * Mint a one-shot signed upload URL for a file or video answer. The browser
 * uploads straight to the private bucket (server actions cap bodies at ~1 MB),
 * and the signed URL is what authorizes the write. The file type and size are
 * checked here against the QUESTION it's for, so a screenshots field can't be
 * used to park a 200 MB zip.
 */
export async function getChallengeUploadToken(input: {
  slug: string;
  questionId: string;
  filename: string;
  size: number;
}): Promise<UploadToken> {
  const loaded = await loadContext(input.slug);
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  if (!canRegister(ctx.challenge)) {
    return { ok: false, error: "This challenge has closed." };
  }
  const q = ctx.challenge.questions.find((x) => x.id === input.questionId);
  if (!q || (q.type !== "file" && q.type !== "video")) {
    return { ok: false, error: "That question doesn't take uploads." };
  }
  const ext = fileExtension(String(input.filename ?? ""));
  const allowed = q.type === "video" ? VIDEO_EXTENSIONS : extensionsFor(q.fileKind);
  if (!allowed.includes(ext)) {
    return {
      ok: false,
      error: `That file type isn't accepted here. Try ${allowed
        .slice(0, 6)
        .map((e) => "." + e)
        .join(", ")}.`,
    };
  }
  const cap = q.type === "video" ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
  if (!Number.isFinite(input.size) || input.size <= 0 || input.size > cap) {
    return {
      ok: false,
      error: `Files here can be up to ${Math.round(cap / 1024 / 1024)} MB.`,
    };
  }
  const rl = await checkRateLimit({
    kind: "challenge-upload",
    identifier: ctx.userId,
    limit: 30,
    windowSeconds: 60,
  });
  if (!rl.ok) return { ok: false, error: "Too many uploads at once — wait a moment." };

  const dot = input.filename.lastIndexOf(".");
  const base = dot > 0 ? input.filename.slice(0, dot) : input.filename;
  const path = `${uploadPrefix(ctx)}${safeSegment(q.id)}/${Date.now()}-${safeSegment(base)}.${ext}`;

  try {
    await ensureUploadBucket(ctx.admin);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Storage isn't ready yet." };
  }
  const { data, error } = await ctx.admin.storage
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

/** Short-lived view URLs for the entrant's own uploaded files (previews on
 *  the form after a reload). Only paths inside their own folder. */
export async function getMyUploadPreviewUrls(input: {
  slug: string;
  paths: string[];
}): Promise<Record<string, string>> {
  const loaded = await loadContext(input.slug);
  if (!loaded.ok) return {};
  const { ctx } = loaded;
  const mine = (input.paths ?? [])
    .filter((p) => typeof p === "string" && p.startsWith(uploadPrefix(ctx)))
    .slice(0, 40);
  if (!mine.length) return {};
  const { data } = await ctx.admin.storage
    .from(CHALLENGE_UPLOAD_BUCKET)
    .createSignedUrls(mine, 3600);
  const out: Record<string, string> = {};
  for (const row of data ?? []) {
    if (row.path && row.signedUrl) out[row.path] = row.signedUrl;
  }
  return out;
}

