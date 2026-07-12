"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";
import {
  sanitizeQuestions,
  type ChallengeStatus,
  type ChallengeQuestion,
} from "@/lib/challenges";

export type ChallengeInput = {
  id?: string;
  slug?: string;
  title: string;
  description: string;
  prize_label: string;
  prize_amount_cents?: number | null;
  marquee_text: string;
  cta_label: string;
  cta_href?: string | null;
  opens_at?: string | null;
  closes_at?: string | null;
  questions: unknown;
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

/** Revalidate every route that reflects challenge state. */
function revalidateChallengeSurfaces(id?: string) {
  revalidatePath("/"); // hero marquee + winners strip
  revalidatePath("/challenges"); // index
  revalidatePath("/challenges/[slug]", "page"); // apply / results pages
  revalidatePath("/opengraph-image");
  revalidatePath("/admin/challenges");
  if (id) revalidatePath(`/admin/challenges/${id}`);
}

/**
 * Create or update a challenge. Status is NOT written here — it's owned by
 * setChallengeStatus so activation can atomically demote the incumbent
 * without tripping the one-active DB index. New challenges start as `draft`.
 */
export async function saveChallenge(
  input: ChallengeInput,
): Promise<ActionResult<{ id: string; slug: string }>> {
  return runAction({ name: "saveChallenge" }, async () => {
    await assertAdmin();

    const title = (input.title ?? "").trim();
    if (!title) throw new Error("Title is required");

    const admin = createAdminClient();

    // Resolve a unique slug (from the provided slug, else the title). Suffix
    // -2/-3… on collision, ignoring the row being edited.
    const base = slugify(input.slug?.trim() || title) || "challenge";
    let slug = base;
    for (let n = 2; ; n++) {
      const { data: clash } = await admin
        .from("challenges")
        .select("id")
        .eq("slug", slug)
        .maybeSingle();
      if (!clash || clash.id === input.id) break;
      slug = `${base}-${n}`;
    }

    const prizeAmount =
      input.prize_amount_cents == null ||
      (input.prize_amount_cents as any) === ""
        ? null
        : Number(input.prize_amount_cents);
    if (prizeAmount !== null && (!Number.isFinite(prizeAmount) || prizeAmount < 0)) {
      throw new Error("Prize amount must be 0 or more cents");
    }

    const ctaHref = (input.cta_href ?? "").trim() || null;
    if (ctaHref && !/^(https?:\/\/|\/)/.test(ctaHref)) {
      throw new Error("CTA link must start with http(s):// or /");
    }

    const opensAt = (input.opens_at ?? "").trim() || null;
    const closesAt = (input.closes_at ?? "").trim() || null;
    if (opensAt && closesAt && new Date(closesAt) < new Date(opensAt)) {
      throw new Error("Close date is before the open date");
    }

    const questions: ChallengeQuestion[] = sanitizeQuestions(input.questions, {
      assignMissingIds: true,
    });
    // Structural sanity: every select needs ≥2 options.
    for (const q of questions) {
      if (q.type === "select" && q.options.length < 2) {
        throw new Error(`"${q.label}" needs at least 2 options`);
      }
    }

    const payload: Record<string, any> = {
      slug,
      title,
      description: (input.description ?? "").trim(),
      prize_label: (input.prize_label ?? "").trim(),
      prize_amount_cents: prizeAmount,
      marquee_text: (input.marquee_text ?? "").trim(),
      cta_label: (input.cta_label ?? "").trim() || "Apply",
      cta_href: ctaHref,
      opens_at: opensAt,
      closes_at: closesAt,
      questions,
      winners_published: input.winners_published === true,
    };

    let id = input.id ?? null;
    if (id) {
      const { error } = await admin
        .from("challenges")
        .update(payload)
        .eq("id", id);
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
      payload: { title, slug },
    });

    revalidateChallengeSurfaces(id!);
    return { id: id!, slug };
  });
}

/**
 * Set a challenge's status. Activating demotes any other active challenge to
 * `closed` in the same call so the one-active DB index is never violated.
 */
export async function setChallengeStatus(
  id: string,
  status: ChallengeStatus,
): Promise<ActionResult> {
  return runAction({ name: "setChallengeStatus" }, async () => {
    await assertAdmin();
    if (!ALLOWED_STATUSES.includes(status)) {
      throw new Error(`Invalid status "${status}"`);
    }
    const admin = createAdminClient();

    if (status === "active") {
      // Demote the incumbent first (exclude this row) so activating never
      // collides on challenges_one_active.
      const { error: demoteErr } = await admin
        .from("challenges")
        .update({ status: "closed" })
        .eq("status", "active")
        .neq("id", id);
      if (demoteErr) throw new Error(`Activate failed: ${demoteErr.message}`);
    }

    const { error } = await admin
      .from("challenges")
      .update({ status })
      .eq("id", id);
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
 * Delete a challenge. If submissions exist, ARCHIVE instead (preserves funded
 * history + public winners). Only a submission-free challenge is hard-deleted.
 */
export async function deleteChallenge(id: string): Promise<ActionResult> {
  return runAction({ name: "deleteChallenge" }, async () => {
    await assertAdmin();
    const admin = createAdminClient();

    const { count } = await admin
      .from("challenge_submissions")
      .select("id", { count: "exact", head: true })
      .eq("challenge_id", id);

    if ((count ?? 0) > 0) {
      const { error } = await admin
        .from("challenges")
        .update({ status: "archived" })
        .eq("id", id);
      if (error) throw new Error(`Archive failed: ${error.message}`);
      await logAudit({
        action: "challenge.archived",
        targetType: "challenge",
        targetId: id,
      });
    } else {
      const { error } = await admin.from("challenges").delete().eq("id", id);
      if (error) throw new Error(`Delete failed: ${error.message}`);
      await logAudit({
        action: "challenge.deleted",
        targetType: "challenge",
        targetId: id,
      });
    }
    revalidateChallengeSurfaces(id);
  });
}

export type ReviewInput = {
  submissionId: string;
  status: "submitted" | "shortlisted" | "funded" | "rejected";
  payout_amount_cents?: number | null;
  review_notes?: string | null;
  winner_public?: boolean;
  public_name?: string | null;
  public_blurb?: string | null;
  public_project_url?: string | null;
};

/** Review a single submission: status, payout, notes, and public-winner curation. */
export async function reviewChallengeSubmission(
  input: ReviewInput,
): Promise<ActionResult> {
  return runAction({ name: "reviewChallengeSubmission" }, async () => {
    const { userId } = await assertAdmin();
    if (!ALLOWED_SUBMISSION_STATUSES.has(input.status)) {
      throw new Error(`Invalid status "${input.status}"`);
    }

    const payout =
      input.payout_amount_cents == null ||
      (input.payout_amount_cents as any) === ""
        ? null
        : Number(input.payout_amount_cents);
    if (payout !== null && (!Number.isFinite(payout) || payout < 0)) {
      throw new Error("Payout must be 0 or more cents");
    }

    const winnerPublic = input.winner_public === true;
    const publicName = (input.public_name ?? "").trim();
    if (winnerPublic) {
      if (input.status !== "funded") {
        throw new Error("Only funded submissions can be shown publicly");
      }
      if (!publicName) {
        throw new Error("A public display name is required to publish a winner");
      }
    }
    const projectUrl = (input.public_project_url ?? "").trim();
    if (projectUrl && !/^https?:\/\/.+/.test(projectUrl)) {
      throw new Error("Project link must start with http(s)://");
    }

    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("challenge_submissions")
      .select("id, challenge_id")
      .eq("id", input.submissionId)
      .maybeSingle();
    if (!sub) throw new Error("Submission not found");

    const { error } = await admin
      .from("challenge_submissions")
      .update({
        status: input.status,
        payout_amount_cents: payout,
        review_notes: (input.review_notes ?? "").trim() || null,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
        winner_public: winnerPublic,
        public_name: winnerPublic ? publicName : null,
        public_blurb: winnerPublic
          ? (input.public_blurb ?? "").trim() || null
          : null,
        public_project_url: winnerPublic ? projectUrl || null : null,
      })
      .eq("id", input.submissionId);
    if (error) throw new Error(`Save failed: ${error.message}`);

    await logAudit({
      action: "challenge_submission.reviewed",
      targetType: "challenge_submission",
      targetId: input.submissionId,
      payload: { status: input.status, winner_public: winnerPublic },
    });

    // Admin surfaces + public winners strip (state may have changed).
    revalidatePath("/admin/challenges");
    revalidatePath(`/admin/challenges/${sub.challenge_id}`);
    revalidatePath(`/admin/challenges/${sub.challenge_id}/submissions`);
    revalidatePath("/");
    revalidatePath("/challenges");
    revalidatePath("/challenges/[slug]", "page");
  });
}
