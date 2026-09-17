"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";
import {
  awardScholarship,
  declineScholarship,
  revokeScholarshipAward,
  issueScholarshipRefund,
  inviteToScholarship,
  getScholarshipById,
} from "@/lib/scholarships";
import {
  awardTypeOf,
  hasAnyPerk,
  hasMoney,
  normalizeCents,
  normalizePercent,
  normalizePerks,
  SCHOLARSHIP_KINDS,
  ELIGIBLE_STAGES,
  type AwardTerms,
  type ScholarshipKind,
  type EligibleStage,
} from "@/lib/scholarship-award";
import {
  validateQuestionList,
  MAX_QUESTIONS,
  type CustomQuestion,
} from "@/lib/question-schema";

const LIST = "/admin/scholarships";
const QUEUE = "/admin/scholarships/applications";

const SLUG_RE = /^[a-z][a-z0-9-]{1,47}$/;

/**
 * Name the migration a save is missing, rather than echoing PostgREST's
 * "column does not exist". Migrations here are pasted by hand after the
 * deploy that needs them, so this is a to-do, not a bug.
 */
function explainSchemaError(message: string): string {
  if (!/does not exist|schema cache/i.test(message)) return message;
  if (/perk_|scholarships_award_type/i.test(message)) {
    return "Perks aren't switched on in the database yet — run migration 0074_scholarship_perks.sql first.";
  }
  return "The scholarships table isn't there yet — run migration 0071 first.";
}

export type ScholarshipInput = {
  id?: string | null;
  slug: string;
  name: string;
  kind: string;
  tagline: string;
  description: string;
  /**
   * The money half. `money` is the "Money off tuition" tick; the two boxes
   * under it are read only while it's on, so an unticked-but-filled box can't
   * smuggle a discount onto a perks-only scholarship.
   */
  money: boolean;
  awardDollars: string;
  awardPercent: string;
  /**
   * The perks (0074). Each count perk is a tick plus a "how many" box, read
   * the same way: the count only counts while its box is ticked. Kept as
   * strings straight from the inputs; parsed once, here.
   */
  mentorCallsOn: boolean;
  mentorCalls: string;
  feedbackCreditsOn: boolean;
  feedbackCredits: string;
  demoDayTicketsOn: boolean;
  demoDayTickets: string;
  aiBoost: boolean;
  seats: string;
  opensAt: string;
  closesAt: string;
  eligibleStages: string[];
  enabled: boolean;
  sortIndex: string;
};

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return /^[a-z]/.test(base) ? base : `s-${base}`.slice(0, 48);
}

/**
 * Turn the admin form into a `scholarships` row, rejecting anything the
 * database constraints would reject anyway — with a message a human can act
 * on, rather than a Postgres constraint name.
 */
function buildRow(input: ScholarshipInput) {
  const name = input.name?.trim() ?? "";
  if (!name) throw new Error("Give the scholarship a name.");
  if (name.length > 120) throw new Error("That name is too long.");

  const slug = (input.slug?.trim() || slugify(name)).toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      "The URL slug must start with a letter and use only lowercase letters, numbers and hyphens.",
    );
  }

  const kind: ScholarshipKind = (SCHOLARSHIP_KINDS as readonly string[]).includes(
    input.kind,
  )
    ? (input.kind as ScholarshipKind)
    : "need";

  // Dollars in the form, cents in the column. Done here rather than in the
  // client so a hand-posted payload can't smuggle in a cents figure that the
  // form would have shown as a thousand-fold larger number. Both boxes read
  // as empty while "Money off tuition" is unticked.
  const money = input.money === true;
  const dollars = Number(input.awardDollars);
  const awardCents =
    money && Number.isFinite(dollars) ? normalizeCents(dollars * 100) : 0;
  const awardPercent = money ? normalizePercent(input.awardPercent) : null;
  if (money && awardCents <= 0 && awardPercent === null) {
    throw new Error(
      "Money off tuition needs an amount or a percentage — otherwise it's worth nothing.",
    );
  }

  // The perks (0074). A count perk only counts while ticked; a ticked one with
  // nothing in the box is an unfinished thought, not "none" — saving it would
  // quietly drop the perk the admin meant to add, so say so instead.
  const perks = normalizePerks({
    mentorCalls: input.mentorCallsOn ? input.mentorCalls : 0,
    feedbackCredits: input.feedbackCreditsOn ? input.feedbackCredits : 0,
    demoDayTickets: input.demoDayTicketsOn ? input.demoDayTickets : 0,
    aiBoost: input.aiBoost === true,
  });
  if (input.mentorCallsOn && perks.mentorCalls <= 0) {
    throw new Error("Extra mentor calls is ticked — say how many.");
  }
  if (input.feedbackCreditsOn && perks.feedbackCredits <= 0) {
    throw new Error("Feedback credits is ticked — say how many.");
  }
  if (input.demoDayTicketsOn && perks.demoDayTickets <= 0) {
    throw new Error("Demo Day guest tickets is ticked — say how many.");
  }

  // Mirrors the scholarships_award_shape check constraint: a scholarship
  // worth nothing is a form that wastes an applicant's time — caught here so
  // the admin sees why rather than a constraint name.
  const terms: AwardTerms = { amountCents: awardCents, percent: awardPercent, perks };
  if (!hasMoney(terms) && !hasAnyPerk(perks)) {
    throw new Error(
      "A scholarship has to be worth something — tick money off tuition, at least one perk, or both.",
    );
  }

  const stages = (input.eligibleStages ?? []).filter((s): s is EligibleStage =>
    (ELIGIBLE_STAGES as readonly string[]).includes(s),
  );
  if (stages.length === 0) {
    throw new Error(
      "Pick at least one stage — otherwise nobody can ever apply to it.",
    );
  }

  const seatsNum = input.seats?.trim() === "" ? null : Number(input.seats);
  if (seatsNum !== null && (!Number.isFinite(seatsNum) || seatsNum < 0)) {
    throw new Error("Seats must be a whole number, or blank for unlimited.");
  }

  const opensAt = input.opensAt?.trim() ? new Date(input.opensAt) : null;
  const closesAt = input.closesAt?.trim() ? new Date(input.closesAt) : null;
  if (opensAt && Number.isNaN(opensAt.getTime())) {
    throw new Error("That opening date isn't valid.");
  }
  if (closesAt && Number.isNaN(closesAt.getTime())) {
    throw new Error("That closing date isn't valid.");
  }
  if (opensAt && closesAt && closesAt <= opensAt) {
    throw new Error("It has to close after it opens.");
  }

  const sortIndex = Number(input.sortIndex);

  return {
    slug,
    name,
    kind,
    tagline: input.tagline?.trim() || null,
    description: input.description?.trim() || null,
    // Derived, never chosen: the summary the catalog groups on.
    award_type: awardTypeOf(terms),
    // Keep both columns honest: a percentage award stores no flat amount, and
    // an unticked money box stores nothing. Leaving stale values behind is how
    // a scholarship ends up describing itself two ways.
    award_cents: awardPercent === null ? awardCents : 0,
    award_percent: awardPercent,
    mentor_calls: perks.mentorCalls,
    perk_feedback_credits: perks.feedbackCredits,
    perk_demo_day_tickets: perks.demoDayTickets,
    perk_ai_boost: perks.aiBoost,
    seats: seatsNum === null ? null : Math.floor(seatsNum),
    opens_at: opensAt ? opensAt.toISOString() : null,
    closes_at: closesAt ? closesAt.toISOString() : null,
    eligible_stages: [...new Set(stages)],
    enabled: input.enabled !== false,
    sort_index: Number.isFinite(sortIndex) ? Math.floor(sortIndex) : 100,
  };
}

export async function saveScholarship(
  input: ScholarshipInput,
): Promise<ActionResult<{ id: string; slug: string }>> {
  return runAction({ name: "saveScholarship" }, async () => {
    const { userId } = await assertPermission("scholarships.manage");
    const admin = createAdminClient();
    const row = buildRow(input);

    if (input.id) {
      const { data, error } = await admin
        .from("scholarships")
        .update(row)
        .eq("id", input.id)
        .select("id, slug")
        .single();
      if (error) {
        if (/duplicate key|unique/i.test(error.message)) {
          throw new Error(`The slug "${row.slug}" is already taken.`);
        }
        throw new Error(explainSchemaError(error.message));
      }
      await logAudit({
        action: "scholarship.updated",
        targetType: "scholarship",
        targetId: input.id,
        payload: row,
      });
      revalidatePath(LIST);
      revalidatePath(`${LIST}/${input.id}`);
      revalidatePath(`/dashboard/scholarships/${data.slug}`);
      return { id: data.id, slug: data.slug };
    }

    const { data, error } = await admin
      .from("scholarships")
      .insert({ ...row, created_by: userId, questions: [] })
      .select("id, slug")
      .single();
    if (error) {
      if (/duplicate key|unique/i.test(error.message)) {
        throw new Error(`The slug "${row.slug}" is already taken.`);
      }
      throw new Error(explainSchemaError(error.message));
    }

    await logAudit({
      action: "scholarship.created",
      targetType: "scholarship",
      targetId: data.id,
      payload: row,
    });
    revalidatePath(LIST);
    return { id: data.id, slug: data.slug };
  });
}

/**
 * Delete a scholarship.
 *
 * Refuses once anyone has been awarded it. The FK cascades, so deleting would
 * take the award rows with it — including ones whose money has already moved
 * as a discount or a refund, leaving the payment ledger referring to a
 * scholarship that no longer exists. Disable it instead; the catalog read
 * keeps showing a disabled scholarship to students who already applied.
 */
export async function deleteScholarship(id: string): Promise<ActionResult> {
  return runAction({ name: "deleteScholarship" }, async () => {
    await assertPermission("scholarships.manage");
    const admin = createAdminClient();

    const { count } = await admin
      .from("scholarship_applications")
      .select("id", { count: "exact", head: true })
      .eq("scholarship_id", id)
      .neq("status", "draft");

    if ((count ?? 0) > 0) {
      throw new Error(
        `${count} ${count === 1 ? "student has" : "students have"} applied to this. Disable it instead — deleting would erase their applications, and any award already paid out.`,
      );
    }

    const { error } = await admin.from("scholarships").delete().eq("id", id);
    if (error) throw new Error(error.message);

    await logAudit({
      action: "scholarship.deleted",
      targetType: "scholarship",
      targetId: id,
    });
    revalidatePath(LIST);
  });
}

export async function setScholarshipEnabled(
  id: string,
  enabled: boolean,
): Promise<ActionResult> {
  return runAction({ name: "setScholarshipEnabled" }, async () => {
    await assertPermission("scholarships.manage");
    const admin = createAdminClient();
    const { error } = await admin
      .from("scholarships")
      .update({ enabled })
      .eq("id", id);
    if (error) throw new Error(error.message);
    await logAudit({
      action: enabled ? "scholarship.enabled" : "scholarship.disabled",
      targetType: "scholarship",
      targetId: id,
    });
    revalidatePath(LIST);
  });
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type AwardOutcome = { refundDueCents: number };

export async function awardScholarshipAction(input: {
  applicationId: string;
  note?: string;
  /** Override the catalog amount for this one student, in DOLLARS. */
  overrideDollars?: string;
}): Promise<ActionResult<AwardOutcome>> {
  return runAction({ name: "awardScholarship" }, async () => {
    const { userId } = await assertPermission("scholarships.manage");

    let overrideCents: number | null = null;
    if (input.overrideDollars && input.overrideDollars.trim() !== "") {
      const n = Number(input.overrideDollars);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error("That override amount isn't a number.");
      }
      overrideCents = Math.round(n * 100);
    }

    const result = await awardScholarship({
      applicationId: input.applicationId,
      reviewerId: userId,
      note: input.note ?? null,
      overrideCents,
    });
    if (!result.ok) throw new Error(result.error);

    await logAudit({
      action: "scholarship.awarded",
      targetType: "scholarship_application",
      targetId: input.applicationId,
      payload: {
        override_cents: overrideCents,
        refund_due_cents: result.refundDueCents,
      },
    });

    revalidatePath(QUEUE);
    revalidatePath(`${QUEUE}/${input.applicationId}`);
    return { refundDueCents: result.refundDueCents };
  });
}

export async function declineScholarshipAction(input: {
  applicationId: string;
  note?: string;
}): Promise<ActionResult> {
  return runAction({ name: "declineScholarship" }, async () => {
    const { userId } = await assertPermission("scholarships.manage");
    const result = await declineScholarship({
      applicationId: input.applicationId,
      reviewerId: userId,
      note: input.note ?? null,
    });
    if (!result.ok) throw new Error(result.error);

    await logAudit({
      action: "scholarship.declined",
      targetType: "scholarship_application",
      targetId: input.applicationId,
    });
    revalidatePath(QUEUE);
    revalidatePath(`${QUEUE}/${input.applicationId}`);
  });
}

export async function revokeScholarshipAwardAction(input: {
  applicationId: string;
  note?: string;
}): Promise<ActionResult> {
  return runAction({ name: "revokeScholarshipAward" }, async () => {
    const { userId } = await assertPermission("scholarships.manage");
    const result = await revokeScholarshipAward({
      applicationId: input.applicationId,
      reviewerId: userId,
      note: input.note ?? null,
    });
    if (!result.ok) throw new Error(result.error);

    await logAudit({
      action: "scholarship.award_revoked",
      targetType: "scholarship_application",
      targetId: input.applicationId,
    });
    revalidatePath(QUEUE);
    revalidatePath(`${QUEUE}/${input.applicationId}`);
  });
}

/**
 * Issue the partial Stripe refund for an award to a student who already paid.
 *
 * The ONLY action in this feature that moves money, which is exactly why it is
 * its own button behind its own confirmation rather than a side effect of
 * awarding. The lib refuses a full-value refund outright: Stripe flips
 * `charge.refunded` on a full refund, and the webhook would then delete the
 * enrollment — silently un-enrolling the student we just gave a scholarship to.
 */
export async function issueScholarshipRefundAction(
  applicationId: string,
): Promise<ActionResult<{ refundId: string; amountCents: number }>> {
  return runAction({ name: "issueScholarshipRefund" }, async () => {
    const { userId } = await assertPermission("scholarships.manage");
    const result = await issueScholarshipRefund({
      applicationId,
      reviewerId: userId,
    });
    if (!result.ok) throw new Error(result.error);

    await logAudit({
      action: "scholarship.refunded",
      targetType: "scholarship_application",
      targetId: applicationId,
      payload: {
        stripe_refund_id: result.refundId,
        amount_cents: result.amountCents,
      },
    });

    revalidatePath(QUEUE);
    revalidatePath(`${QUEUE}/${applicationId}`);
    return { refundId: result.refundId, amountCents: result.amountCents };
  });
}

export async function inviteToScholarshipAction(input: {
  userId: string;
  scholarshipId: string;
  note?: string;
}): Promise<ActionResult> {
  return runAction({ name: "inviteToScholarship" }, async () => {
    await assertPermission("scholarships.manage");
    const result = await inviteToScholarship({
      userId: input.userId,
      scholarshipId: input.scholarshipId,
      note: input.note ?? null,
    });
    if (!result.ok) throw new Error(result.error);

    await logAudit({
      action: "scholarship.invited",
      targetType: "scholarship",
      targetId: input.scholarshipId,
      payload: { user_id: input.userId },
    });
  });
}

/**
 * Coerce the editor's payload into the canonical shape and validate it —
 * the same two steps as cleanCustom in app/admin/application-questions.
 *
 * Coerce, don't normalize. normalizeQuestions is the tolerant READ path: it
 * silently drops a question it can't parse, which on a save path means a
 * punctuation-only label or the 41st question vanishes and the admin is told
 * the save worked. Validation has to see the raw list to report the error
 * written for exactly that mistake.
 */
function cleanQuestions(input: unknown, what: string): CustomQuestion[] {
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_QUESTIONS) {
    throw new Error(`${what}: too many questions (max ${MAX_QUESTIONS}).`);
  }

  const coerced: CustomQuestion[] = list.map((raw: any) => ({
    id: typeof raw?.id === "string" ? raw.id.trim() : "",
    type: raw?.type,
    label: typeof raw?.label === "string" ? raw.label.trim() : "",
    help: typeof raw?.help === "string" ? raw.help : "",
    placeholder: typeof raw?.placeholder === "string" ? raw.placeholder : "",
    required: raw?.required === true,
    hidden: raw?.hidden === true,
    options: Array.isArray(raw?.options)
      ? raw.options.map((o: any) => ({
          value: typeof o?.value === "string" ? o.value.trim() : "",
          label: typeof o?.label === "string" ? o.label.trim() : "",
        }))
      : [],
  }));

  // Fills any blank id in place, so `coerced` is what has to be stored.
  const err = validateQuestionList(coerced);
  if (err) throw new Error(`${what}: ${err}`);
  return coerced;
}

/**
 * Save one scholarship's questions from its own edit page.
 *
 * Returns the list as stored so the panel can adopt any id derived here — a
 * client still holding `id: ""` would re-derive a different key from a
 * reworded label on the next save and orphan the answers already collected.
 */
export async function saveQuestionsForScholarship(
  scholarshipId: string,
  input: unknown,
): Promise<ActionResult<CustomQuestion[]>> {
  return runAction({ name: "saveQuestionsForScholarship" }, async () => {
    await assertPermission("scholarships.manage");
    const admin = createAdminClient();
    const scholarship = await getScholarshipById(admin, scholarshipId);
    if (!scholarship) throw new Error("That scholarship doesn't exist.");

    const questions = cleanQuestions(input, `"${scholarship.name}"`);

    const { error } = await admin
      .from("scholarships")
      .update({ questions })
      .eq("id", scholarshipId);
    if (error) throw new Error(error.message);

    await logAudit({
      action: "scholarship.questions_updated",
      targetType: "scholarship",
      targetId: scholarshipId,
      payload: { count: questions.length },
    });
    revalidatePath(`${LIST}/${scholarshipId}`);
    revalidatePath(`/dashboard/scholarships/${scholarship.slug}`);
    return questions;
  });
}
