"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
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
  sanitizeQuestions,
  isUploadAnswer,
  uploadPathOf,
  extensionsFor,
  fileExtension,
  KIND_LABELS,
  CHALLENGE_UPLOAD_BUCKET,
  VIDEO_EXTENSIONS,
  MAX_VIDEO_BYTES,
  MAX_FILE_BYTES,
  type Challenge,
  type ChallengeAnswers,
  type ChallengeQuestion,
  type ReferralProgress,
  type UploadedFile,
} from "@/lib/challenges";

// ---------------------------------------------------------------------------
// Entrant actions: register → draft (autosave) → submit.
//
// Every write goes through the service-role client AFTER the checks here —
// there is no RLS insert path for registrations or submissions (0087), because
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

  // Best-effort welcome, AFTER the response: registering is the thing the
  // entrant is waiting on, and an email provider having a slow second
  // shouldn't be.
  const c = ctx.challenge;
  const userId = ctx.userId;
  const email = ctx.email;
  after(async () => {
    try {
      const admin = createAdminClient();
      const { data: profile } = await admin
        .from("profiles")
        .select("full_name")
        .eq("id", userId)
        .maybeSingle();
      if (email) {
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
          to: email,
          subject: t.subject,
          html: t.html,
          templateKey: "challenge.registered",
        }).catch(() => null);
      }
      await notify({
        userId,
        type: "challenge_registered",
        title: `You're registered for ${c.title}`,
        body: c.closesAt
          ? `Submissions are due ${new Date(c.closesAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}.`
          : "Submit whenever you're ready.",
        link: `/challenges/${c.slug}`,
      });
    } catch (err) {
      console.error("[challenge] registration fan-out failed", err);
    }
  });
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

/** Every storage path an answer set references (file answers + uploaded videos). */
function referencedPaths(answers: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of Object.values(answers ?? {})) {
    if (isUploadAnswer(v)) out.push(uploadPathOf(v));
    else if (Array.isArray(v)) {
      for (const f of v) {
        if (f && typeof f === "object" && typeof (f as any).path === "string") out.push((f as any).path);
      }
    }
  }
  return out;
}

/** Active content a browser would execute if staff opened the file directly. */
const BLOCKED_MIME = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/(x-)?javascript|text\/javascript)/i;

/**
 * Check uploads the entrant hasn't had checked before against what is REALLY
 * in storage. getChallengeUploadToken's type/size checks run on values the
 * browser reports, and a signed upload URL can't carry a size or type limit,
 * so a tampered client could park anything up to the bucket cap behind an
 * "image". Here each NEW path is looked up: missing, oversize or active-content
 * objects are dropped from the answer (and deleted), and the stored size/type
 * are replaced with storage's own. Paths already in the saved row were checked
 * on an earlier save, which keeps autosave from listing storage every second.
 */
async function verifyNewUploads(
  ctx: Ctx,
  questions: ChallengeQuestion[],
  answers: ChallengeAnswers,
  alreadySaved: Record<string, unknown> | null,
): Promise<{ answers: ChallengeAnswers; unverified: boolean }> {
  const known = new Set(referencedPaths(alreadySaved ?? {}));
  const fresh = referencedPaths(answers).filter((p) => !known.has(p));
  if (fresh.length === 0) return { answers, unverified: false };

  const bucket = ctx.admin.storage.from(CHALLENGE_UPLOAD_BUCKET);
  const meta = new Map<string, { size: number; mimetype: string } | null>();
  let listFailed = false;
  await Promise.all(
    fresh.map(async (path) => {
      const slash = path.lastIndexOf("/");
      const dir = path.slice(0, slash);
      const name = path.slice(slash + 1);
      const { data, error } = await bucket.list(dir, { search: name, limit: 5 });
      // A storage hiccup is not "the file doesn't exist" — don't drop a
      // legitimate upload over it; the caller retries instead.
      if (error) {
        listFailed = true;
        return;
      }
      const hit = (data ?? []).find((o: any) => o.name === name);
      meta.set(
        path,
        hit
          ? {
              size: Number((hit as any).metadata?.size ?? 0),
              mimetype: String((hit as any).metadata?.mimetype ?? ""),
            }
          : null,
      );
    }),
  );
  if (listFailed) return { answers, unverified: true };

  const reject: string[] = [];
  const ok = (path: string, cap: number) => {
    const m = meta.get(path);
    if (m === undefined) return true; // not new
    if (!m || m.size <= 0 || m.size > cap || BLOCKED_MIME.test(m.mimetype)) {
      if (m) reject.push(path);
      return false;
    }
    return true;
  };

  const out: ChallengeAnswers = { ...answers };
  for (const q of questions) {
    const v = out[q.id];
    // Any upload-string answer (video, or a pre-0087 link field that held one).
    if (isUploadAnswer(v)) {
      if (!ok(uploadPathOf(v), MAX_VIDEO_BYTES)) out[q.id] = "";
    } else if (q.type === "file" && Array.isArray(v)) {
      out[q.id] = (v as UploadedFile[])
        .filter((f) => ok(f.path, MAX_FILE_BYTES))
        .map((f) => {
          const m = meta.get(f.path);
          return m ? { ...f, size: m.size, type: m.mimetype || f.type } : f;
        });
    }
  }
  if (reject.length) {
    await bucket.remove(reject).catch(() => null);
  }
  return { answers: out, unverified: false };
}

export type DraftResult = {
  ok: boolean;
  error?: string;
  signIn?: boolean;
  savedAt?: string;
  /** The row's new answers_version — send it back with the next save. */
  version?: number;
  alreadySubmitted?: boolean;
  /** Someone saved newer answers from another tab/device. */
  conflict?: boolean;
  latest?: { answers: ChallengeAnswers; version: number };
  /** Worth retrying automatically (rate limit), vs a permanent refusal. */
  retryable?: boolean;
  closed?: boolean;
};

/**
 * Autosave. Keeps whatever the entrant has typed so far — no required checks —
 * and registers them if they weren't. Only touches a DRAFT: once an entry is
 * submitted, changes go through submitChallengeEntry so they're re-validated.
 *
 * Optimistic concurrency: the client sends the answers_version it last saw. If the
 * row has moved on (another tab or device saved since), nothing is written and
 * the newer answers come back, so a stale tab can never silently replace work
 * done elsewhere. `force` overwrites anyway — the entrant chose "keep mine".
 */
export async function saveChallengeDraft(input: {
  slug: string;
  answers: Record<string, unknown>;
  version?: number | null;
  force?: boolean;
  refCode?: string | null;
}): Promise<DraftResult> {
  const loaded = await loadContext(input.slug);
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  if (!canRegister(ctx.challenge)) {
    return { ok: false, closed: true, error: "This challenge has closed." };
  }
  const rl = await checkRateLimit({
    kind: "challenge-draft",
    identifier: ctx.userId,
    limit: 60,
    windowSeconds: 60,
  });
  if (!rl.ok) return { ok: false, retryable: true, error: "Saving too fast — retrying shortly." };

  const { data: existing } = await ctx.admin
    .from("challenge_submissions")
    .select("id, status, answers_version, answers")
    .eq("challenge_id", ctx.challenge.id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (existing && existing.status !== "draft") {
    return { ok: false, alreadySubmitted: true };
  }

  const { answers: cleaned } = validateAnswers(ctx.challenge.questions, input.answers ?? {}, {
    mode: "draft",
    uploadPrefix: uploadPrefix(ctx),
  });
  const checked = await verifyNewUploads(
    ctx,
    ctx.challenge.questions,
    cleaned,
    (existing?.answers as Record<string, unknown>) ?? null,
  );
  if (checked.unverified) {
    return { ok: false, retryable: true, error: "Couldn't check your upload just now — retrying." };
  }
  const answers = checked.answers;

  try {
    await ensureRegistration(ctx, input.refCode);
  } catch (err: any) {
    return { ok: false, retryable: true, error: err?.message ?? "Couldn't save." };
  }

  const now = new Date().toISOString();
  if (existing) {
    // A tab that has never seen this row (it was created elsewhere after the
    // tab loaded) has no version to offer — that is a conflict too, not a
    // licence to overwrite.
    if (!input.force && input.version == null) {
      return {
        ok: false,
        conflict: true,
        latest: { answers: (existing.answers ?? {}) as ChallengeAnswers, version: existing.answers_version },
      };
    }
    // Write against the version we read: a force ("keep mine") still can't
    // overwrite something newer than the conflict it was shown.
    const base = input.force ? existing.answers_version : input.version!;
    const { data: row, error } = await ctx.admin
      .from("challenge_submissions")
      .update({ answers, questions_snapshot: ctx.challenge.questions, answers_version: base + 1 })
      .eq("id", existing.id)
      .eq("status", "draft")
      .eq("answers_version", base)
      .select("answers_version")
      .maybeSingle();
    if (error) return { ok: false, retryable: true, error: error.message };
    if (!row) {
      // Zero rows: either it was submitted meanwhile, or another tab saved.
      const { data: now2 } = await ctx.admin
        .from("challenge_submissions")
        .select("status, answers_version, answers")
        .eq("id", existing.id)
        .maybeSingle();
      if (now2 && now2.status !== "draft") return { ok: false, alreadySubmitted: true };
      return {
        ok: false,
        conflict: true,
        latest: now2
          ? { answers: (now2.answers ?? {}) as ChallengeAnswers, version: now2.answers_version }
          : undefined,
      };
    }
    return { ok: true, savedAt: now, version: row.answers_version };
  }

  const { data: created, error } = await ctx.admin
    .from("challenge_submissions")
    .insert({
      challenge_id: ctx.challenge.id,
      user_id: ctx.userId,
      answers,
      questions_snapshot: ctx.challenge.questions,
      status: "draft",
      answers_version: 1,
    })
    .select("answers_version")
    .single();
  if (error) {
    // Another tab created the row first — hand its answers back.
    if ((error as any).code === "23505") {
      const { data: row } = await ctx.admin
        .from("challenge_submissions")
        .select("status, answers_version, answers")
        .eq("challenge_id", ctx.challenge.id)
        .eq("user_id", ctx.userId)
        .maybeSingle();
      if (row && row.status !== "draft") return { ok: false, alreadySubmitted: true };
      return {
        ok: false,
        conflict: true,
        latest: row ? { answers: (row.answers ?? {}) as ChallengeAnswers, version: row.answers_version } : undefined,
      };
    }
    return { ok: false, retryable: true, error: error.message };
  }
  return { ok: true, savedAt: now, version: created!.answers_version };
}

export type SubmitResult = {
  ok: boolean;
  error?: string;
  signIn?: boolean;
  fieldErrors?: Record<string, string>;
  referral?: ReferralProgress;
  edited?: boolean;
  version?: number;
  conflict?: boolean;
  latest?: { answers: ChallengeAnswers; version: number };
};

/**
 * Carry answers the current form can't show — a question removed since this
 * entry was submitted, or the pre-0087 standalone demo video — into an edit,
 * so pressing "Save changes" never erases part of an entry.
 */
function carryOver(
  current: ChallengeQuestion[],
  answers: ChallengeAnswers,
  prevAnswers: Record<string, unknown> | null,
  prevSnapshot: unknown,
): { answers: ChallengeAnswers; snapshot: ChallengeQuestion[] } {
  const ids = new Set(current.map((q) => q.id));
  const extraQs: ChallengeQuestion[] = [];
  const extraAnswers: ChallengeAnswers = {};
  for (const q of sanitizeQuestions(prevSnapshot)) {
    if (ids.has(q.id)) continue;
    const v = prevAnswers?.[q.id];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    extraQs.push(q);
    extraAnswers[q.id] = v as any;
  }
  return { answers: { ...answers, ...extraAnswers }, snapshot: [...current, ...extraQs] };
}

/**
 * Submit (or, when edits are allowed, re-submit) an entry. Validates against
 * the challenge's own questions, enforces the referral gate on the FIRST
 * submit, and fans out notifications once.
 *
 * Every state change is a CONDITIONAL write (draft→submitted only if still a
 * draft; an edit only if still 'submitted'), and the result is decided by
 * whether a row changed — not by a read taken earlier in the request — so two
 * tabs can't both "first-submit" (double emails), and an edit that races an
 * admin's review is refused rather than reported as saved.
 */
export async function submitChallengeEntry(input: {
  slug: string;
  answers: Record<string, unknown>;
  version?: number | null;
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
    .select("id, status, submitted_at, answers_version, answers, questions_snapshot")
    .eq("challenge_id", c.id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  const alreadySubmitted = !!existing && existing.status !== "draft";
  if (alreadySubmitted) {
    if (existing!.status !== "submitted") {
      return { ok: false, error: "Your entry has already been reviewed, so it's locked." };
    }
    if (!c.allowEdits) {
      return { ok: false, error: "Entries can't be edited once submitted." };
    }
  }
  // A stale tab must not replace newer answers saved elsewhere (and a tab
  // that never saw the row can't vouch for it either).
  if (existing && existing.answers_version !== input.version) {
    return {
      ok: false,
      conflict: true,
      error: "Newer changes were saved from another tab or device.",
      latest: { answers: (existing.answers ?? {}) as ChallengeAnswers, version: existing.answers_version },
    };
  }

  const { answers: cleaned, errors } = validateAnswers(c.questions, input.answers ?? {}, {
    mode: "submit",
    uploadPrefix: uploadPrefix(ctx),
  });
  if (Object.keys(errors).length) {
    return { ok: false, error: "A few answers need another look.", fieldErrors: errors };
  }
  const checked = await verifyNewUploads(
    ctx,
    c.questions,
    cleaned,
    (existing?.answers as Record<string, unknown>) ?? null,
  );
  if (checked.unverified) {
    return { ok: false, error: "Couldn't check your uploads just now — try again in a moment." };
  }
  const verified = checked.answers;
  // An upload that failed verification may have emptied a required answer.
  const recheck = validateAnswers(c.questions, verified, { mode: "submit" });
  if (Object.keys(recheck.errors).length) {
    return {
      ok: false,
      error: "One of your uploads couldn't be accepted — please upload it again.",
      fieldErrors: recheck.errors,
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
  const { answers, snapshot } = alreadySubmitted
    ? carryOver(c.questions, verified, existing!.answers as any, existing!.questions_snapshot)
    : { answers: verified, snapshot: c.questions };

  let submissionId: string;
  let version: number | undefined;
  let firstSubmit = false;

  if (existing && !alreadySubmitted) {
    const { data: row, error } = await ctx.admin
      .from("challenge_submissions")
      .update({
        answers,
        questions_snapshot: snapshot,
        status: "submitted",
        submitted_at: now,
        answers_version: existing.answers_version + 1,
      })
      .eq("id", existing.id)
      .eq("status", "draft")
      .eq("answers_version", existing.answers_version)
      .select("id, answers_version")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!row) {
      return { ok: false, error: "This entry changed in another tab or device just now — reload to see it." };
    }
    submissionId = row.id;
    version = row.answers_version;
    firstSubmit = true;
  } else if (existing) {
    const { data: row, error } = await ctx.admin
      .from("challenge_submissions")
      .update({ answers, questions_snapshot: snapshot, answers_version: existing.answers_version + 1 })
      .eq("id", existing.id)
      .eq("status", "submitted")
      .eq("answers_version", existing.answers_version)
      .select("id, answers_version")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!row) {
      return {
        ok: false,
        error: "Your entry changed at the same moment (another tab, or it was just reviewed) — reload to see where it stands. Nothing was changed.",
      };
    }
    submissionId = row.id;
    version = row.answers_version;
  } else {
    const referralCode = await attributableRef(ctx, input.refCode);
    const { data: created, error } = await ctx.admin
      .from("challenge_submissions")
      .insert({
        challenge_id: c.id,
        user_id: ctx.userId,
        answers,
        questions_snapshot: snapshot,
        status: "submitted",
        submitted_at: now,
        referral_code: referralCode,
        answers_version: 1,
      })
      .select("id, answers_version")
      .single();
    if (error) {
      if ((error as any).code === "23505") {
        // Another tab created the row first. Don't silently replace what it
        // saved — hand it back so the entrant chooses, like any conflict.
        const { data: row } = await ctx.admin
          .from("challenge_submissions")
          .select("status, answers_version, answers")
          .eq("challenge_id", c.id)
          .eq("user_id", ctx.userId)
          .maybeSingle();
        if (row && row.status === "draft") {
          return {
            ok: false,
            conflict: true,
            error: "This entry was just saved from another tab or device.",
            latest: { answers: (row.answers ?? {}) as ChallengeAnswers, version: row.answers_version },
          };
        }
        return { ok: false, error: "Looks like this was submitted from another tab — reload to see it." };
      } else {
        return { ok: false, error: error.message };
      }
    } else {
      submissionId = created!.id;
      version = created!.answers_version;
      firstSubmit = true;
    }
  }

  if (firstSubmit) {
    const id = submissionId;
    after(() => fanOutSubmitted(ctx, id));
  }

  revalidatePath("/dashboard");
  revalidatePath("/admin/challenges");
  revalidatePath(`/admin/challenges/${c.id}/submissions`);
  return { ok: true, edited: !firstSubmit, version };
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

// The private challenge-uploads bucket is created by migrations 0047/0087;
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
 * and the signed URL is what authorizes the write.
 *
 * The type/size checks here are ADVISORY: they run on what the browser says
 * about the file, and a signed upload URL can't carry a limit. They give an
 * honest entrant an instant, specific error. The enforcement is
 * verifyNewUploads(), which checks the real stored object before any answer
 * is allowed to reference it.
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
