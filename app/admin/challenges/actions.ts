"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { notify } from "@/lib/notifications";
import { env } from "@/lib/env";
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
  challengeWindowState,
  isInputQuestion,
  HTTP_URL_RE,
  type ChallengeStatus,
  type ChallengeQuestion,
  type ChallengePrize,
  type FaqItem,
  type ResourceLink,
  type ScheduleItem,
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

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function blankRow(o: unknown, keys: string[]): boolean {
  if (!o || typeof o !== "object") return true;
  const r = o as Record<string, unknown>;
  return keys.every((k) => r[k] == null || text(r[k]) === "");
}

/** "discord.gg/abc" → "https://discord.gg/abc": what admins actually paste. */
function withScheme(v: unknown): string {
  const t = text(v);
  if (!t || /^https?:\/\//i.test(t)) return t;
  return /^[^\s/]+\.[^\s]{2,}/.test(t) ? `https://${t}` : t;
}

/**
 * Check the editor's lists BEFORE the sanitizers see them. The sanitizers are
 * read-time defences that drop anything malformed without a word — fine for a
 * page render, wrong for a save, where an admin would see "saved" while their
 * half-written FAQ quietly vanished. Rows left completely empty are skipped;
 * a row that's partly filled in gets a specific error naming it.
 */
function checkLists(input: ChallengeInput) {
  const problems: string[] = [];
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);

  const resources = arr(input.resources)
    .filter((r) => !blankRow(r, ["label", "url", "description"]))
    .map((r: any) => ({ ...r, url: withScheme(r.url) }));
  resources.forEach((r: any, i) => {
    const name = text(r.label) || `Link ${i + 1}`;
    if (!text(r.label)) problems.push(`Resource ${i + 1} needs a label`);
    if (!HTTP_URL_RE.test(r.url)) problems.push(`Resource "${name}" needs a link starting with https://`);
  });

  const faq = arr(input.faq).filter((f) => !blankRow(f, ["q", "a"]));
  faq.forEach((f: any, i) => {
    if (!text(f.q)) problems.push(`FAQ ${i + 1} has an answer but no question`);
    else if (!text(f.a)) problems.push(`FAQ "${text(f.q)}" needs an answer`);
  });

  const schedule = arr(input.schedule)
    .filter((m) => !blankRow(m, ["label", "at", "detail", "url"]))
    .map((m: any) => ({ ...m, url: withScheme(m.url) }));
  schedule.forEach((m: any, i) => {
    const name = text(m.label) || `Milestone ${i + 1}`;
    if (!text(m.label)) problems.push(`Milestone ${i + 1} needs a name`);
    if (!text(m.at) || Number.isNaN(new Date(m.at).getTime())) problems.push(`Milestone "${name}" needs a full date and time`);
    if (m.url && !HTTP_URL_RE.test(m.url)) problems.push(`Milestone "${name}" link must start with https://`);
  });

  const prizes = arr(input.prizes).filter(
    (p: any) => !(blankRow(p, ["place", "title", "description", "imageUrl"]) && p?.valueCents == null),
  );
  prizes.forEach((p: any, i) => {
    const name = text(p.place) || `Prize ${i + 1}`;
    if (p.kind === "cash") {
      if (p.valueCents == null && !text(p.title)) problems.push(`Cash prize "${name}" needs an amount`);
    } else if (!text(p.title)) {
      problems.push(`Prize "${name}" needs to say what they win`);
    }
  });

  const questions = arr(input.questions).filter((q: any) => {
    // An untouched "Add custom question" card: skip, don't nag.
    const untouched = !text(q?.label) && !text(q?.help) && !text(q?.placeholder) &&
      !(Array.isArray(q?.options) && q.options.some((o: unknown) => text(o)));
    return !untouched;
  });
  questions.forEach((q: any, i) => {
    const name = text(q.label) || `Question ${i + 1}`;
    if (!text(q.label)) problems.push(`Question ${i + 1} needs a prompt`);
    if (q.type === "select" || q.type === "multi_select") {
      const opts = (Array.isArray(q.options) ? q.options : []).map(text).filter(Boolean);
      if (new Set(opts).size < 2) problems.push(`"${name}" needs at least 2 different choices`);
    }
  });

  if (problems.length) {
    throw new Error(problems.length === 1 ? problems[0] : `${problems[0]} (and ${problems.length - 1} more)`);
  }
  return { resources, faq, schedule, prizes, questions };
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
export type SavedChallenge = {
  id: string;
  slug: string;
  // What was actually stored, so the editor can show exactly that.
  schedule: ScheduleItem[];
  faq: FaqItem[];
  resources: ResourceLink[];
  prizes: ChallengePrize[];
  questions: ChallengeQuestion[];
};

export async function saveChallenge(
  input: ChallengeInput,
): Promise<ActionResult<SavedChallenge>> {
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

    const lists = checkLists(input);
    const questions: ChallengeQuestion[] = sanitizeQuestions(lists.questions, {
      assignMissingIds: true,
    });
    const prizes = sanitizePrizes(lists.prizes);
    const schedule = sanitizeSchedule(lists.schedule);
    const faq = sanitizeFaq(lists.faq);
    const resources = sanitizeResources(lists.resources);

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
      schedule,
      rules: (input.rules ?? "").trim(),
      faq,
      resources,
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
    return { id: id!, slug, schedule, faq, resources, prizes, questions };
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
    if (status === "active") {
      const { data: row } = await admin.from("challenges").select("*").eq("id", id).maybeSingle();
      if (!row) throw new Error("Challenge not found");
      const c = rowToChallenge(row);
      if (c.closesAt && new Date(c.closesAt).getTime() <= Date.now()) {
        throw new Error(
          "Its deadline has already passed, so publishing wouldn't let anyone register or submit. Move the deadline on the Edit tab first.",
        );
      }
      if (c.questions.filter(isInputQuestion).length === 0) {
        throw new Error(
          "Add at least one question before publishing — for a giveaway, quick-add the “Agree to rules” checkbox for a one-click entry.",
        );
      }
    }
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
      .select(
        "id, challenge_id, status, prize_id, award_label, challenge:challenges(prizes, status, opens_at, closes_at, allow_edits)",
      )
      .eq("id", input.submissionId)
      .maybeSingle();
    if (!sub) throw new Error("Submission not found");
    if (sub.status === "draft") {
      throw new Error("This is still a draft — it hasn't been submitted.");
    }
    const ch = Array.isArray((sub as any).challenge) ? (sub as any).challenge[0] : (sub as any).challenge;

    // "Edit until the deadline" is a promise to the entrant. A decision locks
    // their entry, so while that window is still open only "New" is allowed
    // (notes can still be saved). A challenge with no deadline has no window
    // to wait for, so decisions are allowed there.
    if (
      input.status !== "submitted" &&
      input.status !== sub.status &&
      ch?.allow_edits &&
      ch?.closes_at &&
      challengeWindowState({ status: ch.status, opensAt: ch.opens_at, closesAt: ch.closes_at }) === "open"
    ) {
      throw new Error(
        "Entrants can still edit until the deadline, and a decision would lock their entry. Save notes now and decide after it closes.",
      );
    }

    // Prize award: only a winner carries one, and its label is frozen when
    // awarded, so later edits to the prize list — including deleting the
    // prize — never rewrite what this winner won.
    let prizeId: string | null = null;
    let awardLabel: string | null = null;
    if (input.status === "funded" && input.prize_id) {
      if (input.prize_id === sub.prize_id && sub.award_label) {
        prizeId = sub.prize_id;
        awardLabel = sub.award_label;
      } else {
        const prize = sanitizePrizes(ch?.prizes).find((p) => p.id === input.prize_id);
        if (!prize) throw new Error("That prize no longer exists on this challenge");
        prizeId = prize.id;
        awardLabel = awardLabelFor(prize);
      }
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

/**
 * Tell every entrant how it went: a "you won" email to winners and a
 * "results are in" email to everyone else who submitted, plus an in-app
 * notification. Only after winners are published, and each entrant at most
 * once (results_notified_at), so pressing it again after marking a late
 * winner only reaches the people who haven't heard yet.
 */
export async function emailChallengeResults(
  challengeId: string,
): Promise<ActionResult<{ sent: number; failed: number }>> {
  return runAction({ name: "emailChallengeResults" }, async () => {
    await assertPermission("challenges.manage");
    const admin = createAdminClient();
    const { data: row } = await admin.from("challenges").select("*").eq("id", challengeId).maybeSingle();
    if (!row) throw new Error("Challenge not found");
    const c = rowToChallenge(row);
    if (!c.winnersPublished) {
      throw new Error("Publish winners first (Edit tab → Winners), then email results.");
    }
    const { data: subs, error } = await admin
      .from("challenge_submissions")
      .select("id, user_id, status, award_label, applicant:profiles!challenge_submissions_user_id_fkey(full_name, email)")
      .eq("challenge_id", challengeId)
      .neq("status", "draft")
      .is("results_notified_at", null)
      .limit(2000);
    if (error) throw new Error(error.message);

    const pageUrl = `${env.siteUrl}/challenges/${c.slug}`;
    let sent = 0;
    let failed = 0;
    for (const s of (subs ?? []) as any[]) {
      const p = Array.isArray(s.applicant) ? s.applicant[0] : s.applicant;
      const won = s.status === "funded";
      const t = Templates.challengeResult({
        name: p?.full_name ?? null,
        title: c.title,
        won,
        awardLabel: s.award_label,
        pageUrl,
      });
      const res = p?.email
        ? await sendEmail({ to: p.email, subject: t.subject, html: t.html, text: t.text, templateKey: "challenge.result" }).catch(() => ({ ok: false }))
        : { ok: false };
      await notify({
        userId: s.user_id,
        type: won ? "challenge_won" : "challenge_results",
        title: won ? `You won ${c.title}!` : `Results are in for ${c.title}`,
        body: won ? (s.award_label ?? "Congratulations.") : "See who won on the event page.",
        link: `/challenges/${c.slug}`,
        dedupeKey: `challenge-result:${s.id}`,
      });
      if (res.ok) {
        sent++;
        await admin.from("challenge_submissions").update({ results_notified_at: new Date().toISOString() }).eq("id", s.id);
      } else {
        failed++;
      }
    }
    await logAudit({
      action: "challenge.results_emailed",
      targetType: "challenge",
      targetId: challengeId,
      payload: { sent, failed },
    });
    revalidatePath(`/admin/challenges/${challengeId}`, "layout");
    return { sent, failed };
  });
}
