"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";
import {
  sanitizeQuestions,
  sanitizePrizes,
  sanitizeSchedule,
  sanitizeFaq,
  sanitizeResources,
  awardLabelFor,
  fileExtension,
  CHALLENGE_KINDS,
  COVER_THEMES,
  CHALLENGE_MEDIA_BUCKET,
  MAX_REFERRALS_REQUIRED,
  rowToChallenge,
  type ChallengeStatus,
  type ChallengeQuestion,
} from "@/lib/challenges";

export type ChallengeInput = {
  id?: string;
  slug?: string;
  kind: string;
  title: string;
  tagline: string;
  description: string;
  cover_image_url?: string | null;
  cover_theme: string;
  location: string;
  location_url?: string | null;
  prize_label: string;
  prizes: unknown;
  marquee_text: string;
  cta_label: string;
  cta_href?: string | null;
  opens_at?: string | null;
  closes_at?: string | null;
  results_at?: string | null;
  schedule: unknown;
  rules: string;
  faq: unknown;
  resources: unknown;
  questions: unknown;
  referrals_required: number;
  allow_edits: boolean;
  featured: boolean;
  winners_published?: boolean;
};

const ALLOWED_STATUSES: ChallengeStatus[] = [
  "draft",
  "active",
  "closed",
  "archived",
];

const ALLOWED_SUBMISSION_STATUSES = new Set([
  "submitted",
  "shortlisted",
  "funded",
  "rejected",
]);

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function httpOrNull(v: string | null | undefined, field: string): string | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  if (!/^https?:\/\/.+/.test(t)) throw new Error(`${field} must start with https://`);
  return t;
}

/** Revalidate every route that reflects challenge state. */
function revalidateChallengeSurfaces(id?: string) {
  revalidatePath("/"); // hero marquee + winners strip
  revalidatePath("/challenges"); // index
  revalidatePath("/challenges/[slug]", "page");
  revalidatePath("/opengraph-image");
  revalidatePath("/admin/challenges");
  if (id) revalidatePath(`/admin/challenges/${id}`, "layout");
}

async function uniqueSlug(
  admin: ReturnType<typeof createAdminClient>,
  base: string,
  selfId?: string,
): Promise<string> {
  let slug = base;
  for (let n = 2; ; n++) {
    const { data: clash } = await admin
      .from("challenges")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (!clash || clash.id === selfId) return slug;
    slug = `${base}-${n}`;
  }
}

/**
 * Create or update a challenge. Status is NOT written here — it's owned by
 * setChallengeStatus. New challenges start as `draft`.
 */
export async function saveChallenge(
  input: ChallengeInput,
): Promise<ActionResult<{ id: string; slug: string }>> {
  return runAction({ name: "saveChallenge" }, async () => {
    await assertPermission("challenges.manage");

    const title = (input.title ?? "").trim();
    if (!title) throw new Error("Give it a title");

    const admin = createAdminClient();
    const slug = await uniqueSlug(
      admin,
      slugify(input.slug?.trim() || title) || "challenge",
      input.id,
    );

    const kind = (CHALLENGE_KINDS as readonly string[]).includes(input.kind)
      ? input.kind
      : "challenge";
    const coverTheme = (COVER_THEMES as readonly string[]).includes(input.cover_theme)
      ? input.cover_theme
      : "phosphor";

    const ctaHref = (input.cta_href ?? "").trim() || null;
    if (ctaHref && !/^(https?:\/\/|\/)/.test(ctaHref)) {
      throw new Error("Banner link must start with https:// or /");
    }

    const opensAt = (input.opens_at ?? "").trim() || null;
    const closesAt = (input.closes_at ?? "").trim() || null;
    const resultsAt = (input.results_at ?? "").trim() || null;
    if (opensAt && closesAt && new Date(closesAt) < new Date(opensAt)) {
      throw new Error("The deadline is before submissions open");
    }
    if (closesAt && resultsAt && new Date(resultsAt) < new Date(closesAt)) {
      throw new Error("Winners can't be announced before the deadline");
    }

    const questions: ChallengeQuestion[] = sanitizeQuestions(input.questions, {
      assignMissingIds: true,
    });
    for (const q of questions) {
      if ((q.type === "select" || q.type === "multi_select") && q.options.length < 2) {
        throw new Error(`"${q.label}" needs at least 2 choices`);
      }
    }
    const prizes = sanitizePrizes(input.prizes);

    const referralsRequired = Math.round(Number(input.referrals_required) || 0);
    if (referralsRequired < 0 || referralsRequired > MAX_REFERRALS_REQUIRED) {
      throw new Error(`Required referrals must be 0–${MAX_REFERRALS_REQUIRED}`);
    }

    const payload: Record<string, any> = {
      slug,
      kind,
      title,
      tagline: (input.tagline ?? "").trim().slice(0, 200),
      description: (input.description ?? "").trim(),
      cover_image_url: httpOrNull(input.cover_image_url, "Cover image"),
      cover_theme: coverTheme,
      location: (input.location ?? "").trim() || "Online",
      location_url: httpOrNull(input.location_url, "Location link"),
      prize_label: (input.prize_label ?? "").trim(),
      prizes,
      // Keep the legacy amount in step for anything still reading it.
      prize_amount_cents:
        prizes
          .filter((p) => p.kind === "cash" && p.valueCents != null)
          .reduce((s, p) => s + (p.valueCents ?? 0) * p.quantity, 0) || null,
      marquee_text: (input.marquee_text ?? "").trim(),
      cta_label: (input.cta_label ?? "").trim() || "Register",
      cta_href: ctaHref,
      opens_at: opensAt,
      closes_at: closesAt,
      results_at: resultsAt,
      schedule: sanitizeSchedule(input.schedule),
      rules: (input.rules ?? "").trim(),
      faq: sanitizeFaq(input.faq),
      resources: sanitizeResources(input.resources),
      questions,
      referrals_required: referralsRequired,
      allow_edits: input.allow_edits !== false,
      featured: input.featured === true,
      winners_published: input.winners_published === true,
    };

    let id = input.id ?? null;
    if (id) {
      const { error } = await admin.from("challenges").update(payload).eq("id", id);
      if (error) throw new Error(`Save failed: ${error.message}`);
    } else {
      const { data: created, error } = await admin
        .from("challenges")
        .insert({ ...payload, status: "draft" })
        .select("id")
        .single();
      if (error) throw new Error(`Create failed: ${error.message}`);
      id = created!.id;
    }

    await logAudit({
      action: input.id ? "challenge.updated" : "challenge.created",
      targetType: "challenge",
      targetId: id!,
      payload: { title, slug, referrals_required: referralsRequired },
    });

    revalidateChallengeSurfaces(id!);
    return { id: id!, slug };
  });
}

/** Publish / close / archive / unpublish. Several can be live at once now. */
export async function setChallengeStatus(
  id: string,
  status: ChallengeStatus,
): Promise<ActionResult> {
  return runAction({ name: "setChallengeStatus" }, async () => {
    await assertPermission("challenges.manage");
    if (!ALLOWED_STATUSES.includes(status)) {
      throw new Error(`Invalid status "${status}"`);
    }
    const admin = createAdminClient();
    const { error } = await admin.from("challenges").update({ status }).eq("id", id);
    if (error) throw new Error(`Update failed: ${error.message}`);
    await logAudit({
      action: "challenge.status_changed",
      targetType: "challenge",
      targetId: id,
      payload: { status },
    });
    revalidateChallengeSurfaces(id);
  });
}

/**
 * Copy a challenge as a new draft — questions, prizes, rules, FAQ and all —
 * with the dates cleared. Running "the same thing again next week" is the
 * common case, and rebuilding a 10-question form by hand is how typos ship.
 */
export async function duplicateChallenge(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  return runAction({ name: "duplicateChallenge" }, async () => {
    await assertPermission("challenges.manage");
    const admin = createAdminClient();
    const { data: row } = await admin.from("challenges").select("*").eq("id", id).maybeSingle();
    if (!row) throw new Error("Challenge not found");
    const src = rowToChallenge(row);
    const slug = await uniqueSlug(admin, slugify(`${src.slug}-copy`) || "challenge-copy");
    const { data: created, error } = await admin
      .from("challenges")
      .insert({
        slug,
        kind: src.kind,
        title: `${src.title} (copy)`,
        tagline: src.tagline,
        description: src.description,
        cover_image_url: src.coverImageUrl,
        cover_theme: src.coverTheme,
        location: src.location,
        location_url: src.locationUrl,
        prize_label: src.prizeLabel,
        prize_amount_cents: src.prizeAmountCents,
        prizes: src.prizes,
        marquee_text: src.marqueeText,
        cta_label: src.ctaLabel,
        cta_href: null,
        questions: src.questions,
        rules: src.rules,
        faq: src.faq,
        resources: src.resources,
        referrals_required: src.referralsRequired,
        allow_edits: src.allowEdits,
        status: "draft",
      })
      .select("id")
      .single();
    if (error) throw new Error(`Duplicate failed: ${error.message}`);
    await logAudit({
      action: "challenge.duplicated",
      targetType: "challenge",
      targetId: created!.id,
      payload: { from: id },
    });
    revalidatePath("/admin/challenges");
    return { id: created!.id };
  });
}

/**
 * Delete a challenge. If anyone registered or submitted, ARCHIVE instead
 * (preserves winners + history). Only an untouched challenge is hard-deleted.
 */
export async function deleteChallenge(id: string): Promise<ActionResult> {
  return runAction({ name: "deleteChallenge" }, async () => {
    await assertPermission("challenges.manage");
    const admin = createAdminClient();

    const [{ count: subs }, { count: regs }] = await Promise.all([
      admin
        .from("challenge_submissions")
        .select("id", { count: "exact", head: true })
        .eq("challenge_id", id),
      admin
        .from("challenge_registrations")
        .select("id", { count: "exact", head: true })
        .eq("challenge_id", id),
    ]);

    if ((subs ?? 0) > 0 || (regs ?? 0) > 0) {
      const { error } = await admin
        .from("challenges")
        .update({ status: "archived" })
        .eq("id", id);
      if (error) throw new Error(`Archive failed: ${error.message}`);
      await logAudit({ action: "challenge.archived", targetType: "challenge", targetId: id });
    } else {
      const { error } = await admin.from("challenges").delete().eq("id", id);
      if (error) throw new Error(`Delete failed: ${error.message}`);
      await logAudit({ action: "challenge.deleted", targetType: "challenge", targetId: id });
    }
    revalidateChallengeSurfaces(id);
  });
}

/**
 * Signed upload for a cover or prize photo. Goes to the public
 * challenge-media bucket; the browser uploads directly (server actions cap
 * bodies at ~1 MB) and then stores the returned public URL on the form.
 */
export async function getChallengeMediaUploadToken(input: {
  filename: string;
  size: number;
}): Promise<
  ActionResult<{ path: string; token: string; bucket: string; publicUrl: string }>
> {
  return runAction({ name: "getChallengeMediaUploadToken" }, async () => {
    await assertPermission("challenges.manage");
    const ext = fileExtension(String(input.filename ?? ""));
    // Rasters only: an SVG in a public bucket is a script host.
    if (!["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
      throw new Error("Use a PNG, JPG, WEBP or GIF.");
    }
    if (!Number.isFinite(input.size) || input.size <= 0 || input.size > 10 * 1024 * 1024) {
      throw new Error("Images can be up to 10 MB.");
    }
    const admin = createAdminClient();
    // Self-heal on a deploy whose 0087 migration hasn't run yet.
    const { error: bucketErr } = await admin.storage.createBucket(CHALLENGE_MEDIA_BUCKET, {
      public: true,
      fileSizeLimit: 10 * 1024 * 1024,
      allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    });
    if (bucketErr && !/exist/i.test(bucketErr.message)) {
      throw new Error(bucketErr.message);
    }
    const path = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${ext === "jpeg" ? "jpg" : ext}`;
    const { data, error } = await admin.storage
      .from(CHALLENGE_MEDIA_BUCKET)
      .createSignedUploadUrl(path);
    if (error) throw new Error(error.message);
    const { data: pub } = admin.storage.from(CHALLENGE_MEDIA_BUCKET).getPublicUrl(data.path);
    return {
      path: data.path,
      token: data.token,
      bucket: CHALLENGE_MEDIA_BUCKET,
      publicUrl: pub.publicUrl,
    };
  });
}

export type ReviewInput = {
  submissionId: string;
  status: "submitted" | "shortlisted" | "funded" | "rejected";
  prize_id?: string | null;
  payout_amount_cents?: number | null;
  review_notes?: string | null;
  winner_public?: boolean;
  public_name?: string | null;
  public_blurb?: string | null;
  public_project_url?: string | null;
};

/** Review a single submission: decision, prize, payout, notes, public curation. */
export async function reviewChallengeSubmission(
  input: ReviewInput,
): Promise<ActionResult> {
  return runAction({ name: "reviewChallengeSubmission" }, async () => {
    const { userId } = await assertPermission("challenges.manage");
    if (!ALLOWED_SUBMISSION_STATUSES.has(input.status)) {
      throw new Error(`Invalid status "${input.status}"`);
    }

    const payout =
      input.payout_amount_cents == null || (input.payout_amount_cents as any) === ""
        ? null
        : Number(input.payout_amount_cents);
    if (payout !== null && (!Number.isFinite(payout) || payout < 0)) {
      throw new Error("Payout must be 0 or more");
    }

    const winnerPublic = input.winner_public === true;
    const publicName = (input.public_name ?? "").trim();
    if (winnerPublic) {
      if (input.status !== "funded") {
        throw new Error("Only winners can be shown publicly");
      }
      if (!publicName) {
        throw new Error("A public display name is required to publish a winner");
      }
    }
    const projectUrl = (input.public_project_url ?? "").trim();
    if (projectUrl && !/^https?:\/\/.+/.test(projectUrl)) {
      throw new Error("Project link must start with https://");
    }

    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("challenge_submissions")
      .select("id, challenge_id, status, challenge:challenges(prizes)")
      .eq("id", input.submissionId)
      .maybeSingle();
    if (!sub) throw new Error("Submission not found");
    if (sub.status === "draft") {
      throw new Error("This is still a draft — it hasn't been submitted.");
    }

    // Prize award: only a winner carries one, and its label is frozen now so
    // later edits to the prize list don't rewrite history.
    let prizeId: string | null = null;
    let awardLabel: string | null = null;
    if (input.status === "funded" && input.prize_id) {
      const ch = Array.isArray((sub as any).challenge)
        ? (sub as any).challenge[0]
        : (sub as any).challenge;
      const prize = sanitizePrizes(ch?.prizes).find((p) => p.id === input.prize_id);
      if (!prize) throw new Error("That prize no longer exists on this challenge");
      prizeId = prize.id;
      awardLabel = awardLabelFor(prize);
    }

    const { error } = await admin
      .from("challenge_submissions")
      .update({
        status: input.status,
        prize_id: prizeId,
        award_label: awardLabel,
        payout_amount_cents: input.status === "funded" ? payout : null,
        review_notes: (input.review_notes ?? "").trim() || null,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
        winner_public: winnerPublic,
        public_name: winnerPublic ? publicName : null,
        public_blurb: winnerPublic ? (input.public_blurb ?? "").trim() || null : null,
        public_project_url: winnerPublic ? projectUrl || null : null,
      })
      .eq("id", input.submissionId);
    if (error) throw new Error(`Save failed: ${error.message}`);

    await logAudit({
      action: "challenge_submission.reviewed",
      targetType: "challenge_submission",
      targetId: input.submissionId,
      payload: { status: input.status, prize_id: prizeId, winner_public: winnerPublic },
    });

    revalidatePath("/admin/challenges");
    revalidatePath(`/admin/challenges/${sub.challenge_id}`, "layout");
    revalidatePath("/");
    revalidatePath("/challenges");
    revalidatePath("/challenges/[slug]", "page");
  });
}
