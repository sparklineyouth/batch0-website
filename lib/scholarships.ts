import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { notify } from "@/lib/notifications";
import { sendTemplated, emitEmailEvent } from "@/lib/email/dispatch";
import { Templates } from "@/lib/email/templates";
import {
  normalizeQuestions,
  visibleQuestions,
  checkAnswers,
  type CustomQuestion,
} from "@/lib/question-schema";
import {
  awardDiscountCents,
  awardRefundCents,
  callCredits,
  canAward,
  checkEligibility,
  describeAward,
  formatMoney,
  fulfillmentFor,
  normalizeCents,
  normalizeMentorCalls,
  normalizePercent,
  stageOf,
  type ApplicantState,
  type AwardTerms,
  type CallCredits,
  type Eligibility,
  type EligibleStage,
  type Fulfillment,
  type ScholarshipAppStatus,
  type ScholarshipKind,
  type ScholarshipOffer,
  type AwardType,
} from "@/lib/scholarship-award";

// ---------------------------------------------------------------------------
// Scholarships — the database side. Migration 0071.
//
// The arithmetic and the eligibility rules live in lib/scholarship-award.ts,
// which is pure and tested. This module reads and writes, and is the only
// place that does: checkout, the dashboard, the admin queue and the refund
// button all come through here, so none of them can invent their own idea of
// what a student is owed.
//
// Everything takes or builds a SERVICE-ROLE client. `scholarships` and
// `scholarship_applications` carry read policies only (see 0071) — every write
// in this feature is a server action that has already run assertPermission or
// established that the row belongs to the caller. The checks in this file ARE
// the access control for those writes; do not import it into a client
// component.
//
// TEMPLATE KEYS are exported rather than inlined so the admin editor at
// /admin/email/templates and the send site can never disagree about the string.
// ---------------------------------------------------------------------------

export const SCHOLARSHIP_RECEIVED_TEMPLATE = "scholarship.received";
export const SCHOLARSHIP_AWARDED_TEMPLATE = "scholarship.awarded";
export const SCHOLARSHIP_AWARDED_CALLS_TEMPLATE = "scholarship.awarded_calls";
export const SCHOLARSHIP_DECLINED_TEMPLATE = "scholarship.declined";
export const SCHOLARSHIP_REFUNDED_TEMPLATE = "scholarship.refunded";
export const SCHOLARSHIP_INVITE_TEMPLATE = "scholarship.invite";

/** The `site_settings` key holding the shared scholarship block on /apply. */
export const SCHOLARSHIP_INTEREST_SETTING = "scholarship_interest_questions";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type Scholarship = {
  id: string;
  slug: string;
  name: string;
  kind: ScholarshipKind;
  tagline: string | null;
  description: string | null;
  terms: AwardTerms;
  seats: number | null;
  opensAt: string | null;
  closesAt: string | null;
  eligibleStages: EligibleStage[];
  questions: CustomQuestion[];
  enabled: boolean;
  sortIndex: number;
};

export type ScholarshipApplication = {
  id: string;
  scholarshipId: string;
  userId: string;
  applicationId: string | null;
  cohortId: string | null;
  status: ScholarshipAppStatus;
  answers: Record<string, unknown>;
  stageAtApply: EligibleStage | null;
  awardCents: number;
  credits: CallCredits;
  fulfillment: Fulfillment;
  refundedCents: number;
  stripeRefundId: string | null;
  decisionNote: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  createdAt: string;
};

function asKind(v: unknown): ScholarshipKind {
  return v === "merit" || v === "learner" ? v : "need";
}

function asAwardType(v: unknown): AwardType {
  return v === "mentor_calls" ? "mentor_calls" : "discount";
}

function asStatus(v: unknown): ScholarshipAppStatus {
  const all = [
    "draft",
    "submitted",
    "under_review",
    "awarded",
    "declined",
    "withdrawn",
  ];
  return all.includes(String(v)) ? (v as ScholarshipAppStatus) : "draft";
}

function asFulfillment(v: unknown): Fulfillment {
  const all = ["none", "discount", "refund_due", "refunded"];
  return all.includes(String(v)) ? (v as Fulfillment) : "none";
}

function asStages(v: unknown): EligibleStage[] {
  const raw = Array.isArray(v) ? v : [];
  const out = raw.filter(
    (s): s is EligibleStage => s === "accepted" || s === "enrolled",
  );
  // A scholarship nobody can ever apply to is a bug, not a configuration. An
  // empty array reads as "both" rather than "none" so a bad write degrades
  // toward visible rather than toward silently unreachable.
  return out.length ? [...new Set(out)] : ["accepted", "enrolled"];
}

export function mapScholarship(row: Record<string, any>): Scholarship {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: asKind(row.kind),
    tagline: row.tagline ?? null,
    description: row.description ?? null,
    terms: {
      awardType: asAwardType(row.award_type),
      amountCents: normalizeCents(row.award_cents),
      percent: normalizePercent(row.award_percent),
      mentorCalls: normalizeMentorCalls(row.mentor_calls),
    },
    seats: typeof row.seats === "number" ? row.seats : null,
    opensAt: row.opens_at ?? null,
    closesAt: row.closes_at ?? null,
    eligibleStages: asStages(row.eligible_stages),
    questions: normalizeQuestions(row.questions),
    enabled: row.enabled !== false,
    sortIndex: typeof row.sort_index === "number" ? row.sort_index : 100,
  };
}

export function mapScholarshipApplication(
  row: Record<string, any>,
): ScholarshipApplication {
  return {
    id: row.id,
    scholarshipId: row.scholarship_id,
    userId: row.user_id,
    applicationId: row.application_id ?? null,
    cohortId: row.cohort_id ?? null,
    status: asStatus(row.status),
    answers:
      row.answers && typeof row.answers === "object" && !Array.isArray(row.answers)
        ? row.answers
        : {},
    stageAtApply:
      row.stage_at_apply === "accepted" || row.stage_at_apply === "enrolled"
        ? row.stage_at_apply
        : null,
    awardCents: normalizeCents(row.award_cents),
    credits: callCredits(row.mentor_calls_awarded, row.mentor_calls_used),
    fulfillment: asFulfillment(row.fulfillment),
    refundedCents: normalizeCents(row.refunded_cents),
    stripeRefundId: row.stripe_refund_id ?? null,
    decisionNote: row.decision_note ?? null,
    submittedAt: row.submitted_at ?? null,
    decidedAt: row.decided_at ?? null,
    createdAt: row.created_at,
  };
}

/**
 * True when the error means migration 0071 hasn't been applied yet.
 *
 * Same contract as lib/email/store.ts isMissingTable: a deploy can outrun
 * `supabase db push`, and for those few minutes the whole feature must read as
 * "no scholarships" rather than crashing the dashboard for every student. The
 * nav item points at a page that says "nothing open right now", which is
 * correct and recoverable; a 500 on /dashboard is neither.
 */
function isMissingTable(error: { message?: string } | null): boolean {
  return !!error && /does not exist|schema cache/i.test(error.message ?? "");
}

// ---------------------------------------------------------------------------
// Catalog reads
// ---------------------------------------------------------------------------

/** Every scholarship, newest configuration first. Admin-side. */
export async function listScholarships(
  client: SupabaseClient,
): Promise<{ scholarships: Scholarship[]; missingTable: boolean }> {
  const { data, error } = await client
    .from("scholarships")
    .select("*")
    .order("sort_index", { ascending: true })
    .order("name", { ascending: true });
  if (error) {
    if (isMissingTable(error)) return { scholarships: [], missingTable: true };
    console.error("[scholarships] list failed:", error.message);
    return { scholarships: [], missingTable: false };
  }
  return {
    scholarships: (data ?? []).map(mapScholarship),
    missingTable: false,
  };
}

export async function getScholarshipBySlug(
  client: SupabaseClient,
  slug: string,
): Promise<Scholarship | null> {
  const { data, error } = await client
    .from("scholarships")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error || !data) return null;
  return mapScholarship(data);
}

export async function getScholarshipById(
  client: SupabaseClient,
  id: string,
): Promise<Scholarship | null> {
  const { data, error } = await client
    .from("scholarships")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return mapScholarship(data);
}

/**
 * How many awards each scholarship has handed out.
 *
 * One grouped read rather than a count per card: the dashboard renders every
 * open scholarship at once, and seats are shown on each.
 */
export async function awardedCounts(
  client: SupabaseClient,
): Promise<Map<string, number>> {
  const { data, error } = await client
    .from("scholarship_applications")
    .select("scholarship_id")
    .eq("status", "awarded");
  const out = new Map<string, number>();
  if (error || !data) return out;
  for (const row of data as Array<{ scholarship_id: string }>) {
    out.set(row.scholarship_id, (out.get(row.scholarship_id) ?? 0) + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The student's own state
// ---------------------------------------------------------------------------

/** Every scholarship application belonging to one student. */
export async function listApplicationsForUser(
  client: SupabaseClient,
  userId: string,
): Promise<ScholarshipApplication[]> {
  const { data, error } = await client
    .from("scholarship_applications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data.map(mapScholarshipApplication);
}

/**
 * The student's live award, if they hold one.
 *
 * Used by checkout and the accepted page. Returns the AWARDED row only —
 * a pending application is worth nothing at the till, and treating it as a
 * discount would let anyone lower their own price by submitting a form.
 */
export async function getAwardForUser(
  client: SupabaseClient,
  userId: string,
  cohortId?: string | null,
): Promise<{ app: ScholarshipApplication; scholarship: Scholarship } | null> {
  let query = client
    .from("scholarship_applications")
    .select("*, scholarship:scholarships(*)")
    .eq("user_id", userId)
    .eq("status", "awarded");
  if (cohortId) query = query.eq("cohort_id", cohortId);

  const { data, error } = await query
    .order("decided_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;

  const row = data as Record<string, any>;
  if (!row.scholarship) return null;
  return {
    app: mapScholarshipApplication(row),
    scholarship: mapScholarship(row.scholarship),
  };
}

/**
 * What a scholarship takes off `priceCents` for this user.
 *
 * `priceCents` must ALREADY have regional pricing, the site promo and the
 * founder-pass discount applied — a scholarship is the last discount in the
 * stack. See the ordering note in app/api/stripe/checkout/route.ts.
 *
 * Reads the amount snapshotted on the award rather than recomputing from the
 * catalog, EXCEPT for a percentage award, which has to be resolved against the
 * price actually being charged. Editing the catalog must never change what a
 * student was already told they had won.
 *
 * Fails CLOSED to 0 on any error: the failure mode of a bad read here is
 * charging someone full price, which is a refundable support ticket. The
 * inverse — handing out a discount we can't account for — is not.
 */
export async function scholarshipDiscountCentsForUser(
  client: SupabaseClient,
  userId: string,
  cohortId: string | null,
  priceCents: number,
): Promise<number> {
  try {
    const held = await getAwardForUser(client, userId, cohortId);
    if (!held) return 0;
    if (held.scholarship.terms.awardType !== "discount") return 0;
    // Already refunded (or being refunded) against a completed payment — the
    // money has moved once and must not move again as a discount.
    if (held.app.fulfillment === "refunded" || held.app.fulfillment === "refund_due") {
      return 0;
    }
    if (held.scholarship.terms.percent !== null) {
      return awardDiscountCents(held.scholarship.terms, priceCents);
    }
    return Math.max(0, Math.min(normalizeCents(priceCents), held.app.awardCents));
  } catch (err) {
    console.error("[scholarships] discount read failed:", err);
    return 0;
  }
}

/**
 * Assemble the facts lib/scholarship-award.ts needs to decide eligibility.
 *
 * Deliberately returns the raw state rather than a verdict, because the same
 * state answers the question for every scholarship on the page and re-reading
 * it per card would be an N+1 on the dashboard's hot path.
 */
export async function loadApplicantState(
  client: SupabaseClient,
  userId: string,
): Promise<ApplicantState & { applicationId: string | null; cohortId: string | null }> {
  const [{ data: app }, { data: enrollment }, apps] = await Promise.all([
    client
      .from("applications")
      .select("id, status, cohort_id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    client
      .from("enrollments")
      .select("id, cohort_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle(),
    listApplicationsForUser(client, userId),
  ]);

  const liveStatuses = apps
    .map((a) => a.status)
    .filter(
      (s): s is ScholarshipAppStatus =>
        s === "submitted" || s === "under_review" || s === "awarded",
    );

  return {
    applicationStatus: (app as any)?.status ?? null,
    enrolled: !!enrollment,
    liveStatuses,
    applicationId: (app as any)?.id ?? null,
    cohortId: (app as any)?.cohort_id ?? (enrollment as any)?.cohort_id ?? null,
  };
}

/** The offer shape checkEligibility wants, built from a row plus its count. */
export function offerOf(
  scholarship: Scholarship,
  awardedCount: number,
): ScholarshipOffer {
  return {
    name: scholarship.name,
    enabled: scholarship.enabled,
    opensAt: scholarship.opensAt,
    closesAt: scholarship.closesAt,
    seats: scholarship.seats,
    awardedCount,
    eligibleStages: scholarship.eligibleStages,
  };
}

export type ScholarshipCard = {
  scholarship: Scholarship;
  eligibility: Eligibility;
  mine: ScholarshipApplication | null;
  awardedCount: number;
};

/**
 * Everything the student's /dashboard/scholarships page renders, in three
 * reads rather than three per scholarship.
 */
export async function loadScholarshipCards(
  client: SupabaseClient,
  userId: string,
  now: Date,
): Promise<{ cards: ScholarshipCard[]; state: Awaited<ReturnType<typeof loadApplicantState>>; missingTable: boolean }> {
  const [{ scholarships, missingTable }, counts, state] = await Promise.all([
    listScholarships(client),
    awardedCounts(client),
    loadApplicantState(client, userId),
  ]);

  const mineById = new Map<string, ScholarshipApplication>();
  for (const a of await listApplicationsForUser(client, userId)) {
    mineById.set(a.scholarshipId, a);
  }

  const cards = scholarships
    // A disabled scholarship stays visible to someone who already applied to
    // it — their row has to have somewhere to live — but disappears for
    // everyone else.
    .filter((s) => s.enabled || mineById.has(s.id))
    .map((scholarship) => {
      const awardedCount = counts.get(scholarship.id) ?? 0;
      const mine = mineById.get(scholarship.id) ?? null;
      const alreadyAppliedHere =
        !!mine && mine.status !== "withdrawn" && mine.status !== "declined";
      return {
        scholarship,
        awardedCount,
        mine,
        eligibility: checkEligibility(
          offerOf(scholarship, awardedCount),
          state,
          now,
          { alreadyAppliedHere },
        ),
      };
    });

  return { cards, state, missingTable };
}

// ---------------------------------------------------------------------------
// Student actions: apply / submit / withdraw
// ---------------------------------------------------------------------------

export type SubmitResult =
  | { ok: true; applicationId: string }
  | { ok: false; error: string; errors?: Record<string, string> };

/**
 * Save or submit a student's scholarship application.
 *
 * Eligibility is re-checked here, not merely on the page that rendered the
 * form: a server action is its own entry point and is callable by anyone who
 * can guess the action id (the rule lib/server-guards.ts states). The window
 * between rendering a form and submitting it is also exactly long enough for
 * the last seat to go.
 *
 * `submit: false` is the draft path — it skips required-field checks so a
 * half-filled form can be saved, and leaves the row in `draft`.
 */
export async function saveScholarshipApplication(args: {
  userId: string;
  slug: string;
  answers: Record<string, unknown>;
  submit: boolean;
  now?: Date;
}): Promise<SubmitResult> {
  const admin = createAdminClient();
  const now = args.now ?? new Date();

  const scholarship = await getScholarshipBySlug(admin, args.slug);
  if (!scholarship) return { ok: false, error: "That scholarship doesn't exist." };

  const [counts, state, existingRows] = await Promise.all([
    awardedCounts(admin),
    loadApplicantState(admin, args.userId),
    listApplicationsForUser(admin, args.userId),
  ]);

  const existing = existingRows.find((r) => r.scholarshipId === scholarship.id) ?? null;
  const alreadyAppliedHere =
    !!existing && existing.status !== "withdrawn" && existing.status !== "declined";

  // A draft the student is still editing must not be treated as "already
  // applied" against themselves, and neither must a row they're re-opening
  // after withdrawing. Everything else is a genuine block.
  const blocking =
    alreadyAppliedHere && existing?.status !== "draft" ? true : false;

  // Their own live row for THIS scholarship must not count against them via
  // the one-at-a-time rule — that rule is about OTHER scholarships. Recomputed
  // from existingRows rather than filtering state.liveStatuses positionally:
  // that array is itself already filtered, so its indices don't line up with
  // existingRows and the wrong row would be dropped.
  const otherLiveStatuses = existingRows
    .filter((r) => r.scholarshipId !== scholarship.id)
    .map((r) => r.status)
    .filter(
      (s): s is ScholarshipAppStatus =>
        s === "submitted" || s === "under_review" || s === "awarded",
    );

  const eligibility = checkEligibility(
    offerOf(scholarship, counts.get(scholarship.id) ?? 0),
    { ...state, liveStatuses: otherLiveStatuses },
    now,
    { alreadyAppliedHere: blocking },
  );
  if (!eligibility.ok) return { ok: false, error: eligibility.message };

  const questions = visibleQuestions(scholarship.questions);
  const checked = checkAnswers(questions, args.answers, { partial: !args.submit });
  if (!checked.ok) {
    return { ok: false, error: checked.error, errors: checked.errors };
  }

  const payload: Record<string, unknown> = {
    scholarship_id: scholarship.id,
    user_id: args.userId,
    application_id: state.applicationId,
    cohort_id: state.cohortId,
    answers: checked.answers,
    stage_at_apply: eligibility.stage,
    status: args.submit ? "submitted" : "draft",
  };
  if (args.submit) payload.submitted_at = now.toISOString();

  const { data, error } = await admin
    .from("scholarship_applications")
    .upsert(payload, { onConflict: "scholarship_id,user_id" })
    .select("*")
    .single();

  if (error) {
    if (isMissingTable(error)) {
      return { ok: false, error: "Scholarships aren't set up yet. Try again shortly." };
    }
    // The partial unique index (0071) is the database-level backstop for the
    // one-at-a-time rule. Reaching it means two requests raced past the check
    // above, so say what it means rather than leaking the constraint name.
    if (/duplicate key|unique constraint/i.test(error.message)) {
      return {
        ok: false,
        error: "You already hold a batch0 scholarship — only one per student.",
      };
    }
    console.error("[scholarships] save failed:", error.message);
    return { ok: false, error: "Couldn't save that. Try again." };
  }

  const saved = mapScholarshipApplication(data);
  if (args.submit) {
    await announceSubmission(saved, scholarship, args.userId);
  }
  return { ok: true, applicationId: saved.id };
}

/** Let a student take back an application that hasn't been decided. */
export async function withdrawScholarshipApplication(args: {
  userId: string;
  applicationId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = createAdminClient();
  // Conditional update rather than read-then-write: the reviewer may be
  // deciding this exact row right now, and a student must never be able to
  // withdraw an award out from under a decision that already moved money.
  const { data, error } = await admin
    .from("scholarship_applications")
    .update({ status: "withdrawn" })
    .eq("id", args.applicationId)
    .eq("user_id", args.userId)
    .in("status", ["draft", "submitted", "under_review"])
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[scholarships] withdraw failed:", error.message);
    return { ok: false, error: "Couldn't withdraw that. Try again." };
  }
  if (!data) {
    return {
      ok: false,
      error: "That application has already been decided and can't be withdrawn.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

type Recipient = { email: string | null; fullName: string | null };

async function loadRecipient(
  admin: SupabaseClient,
  userId: string,
): Promise<Recipient> {
  const { data } = await admin
    .from("profiles")
    .select("email, contact_email, full_name")
    .eq("id", userId)
    .maybeSingle();
  const row = (data ?? {}) as Record<string, any>;
  // contact_email wins where it's set (migration 0034): it's the address the
  // student asked us to actually use.
  return {
    email: row.contact_email || row.email || null,
    fullName: row.full_name ?? null,
  };
}

async function cohortName(
  admin: SupabaseClient,
  cohortId: string | null,
): Promise<string | null> {
  if (!cohortId) return null;
  const { data } = await admin
    .from("cohorts")
    .select("name")
    .eq("id", cohortId)
    .maybeSingle();
  return (data as any)?.name ?? null;
}

/**
 * Email + notify + automation event for a fresh submission.
 *
 * Every side effect here is independently swallowed, matching the contract the
 * rest of the app uses (lib/admissions.ts, lib/application-decisions.ts): the
 * student's application is already saved, and a mail server having a bad
 * minute must not turn a successful submit into an error they'd retry.
 */
async function announceSubmission(
  app: ScholarshipApplication,
  scholarship: Scholarship,
  userId: string,
) {
  const admin = createAdminClient();
  const summary = describeAward(scholarship.terms);
  try {
    const to = await loadRecipient(admin, userId);
    if (to.email) {
      await sendTemplated(SCHOLARSHIP_RECEIVED_TEMPLATE, {
        to: to.email,
        toName: to.fullName,
        userId,
        vars: {
          scholarship_name: scholarship.name,
          award_summary: summary,
        },
        // One email per submission, even if the action is retried.
        dedupeKey: `scholarship-received:${app.id}`,
        fallback: () =>
          Templates.scholarshipReceived({
            name: to.fullName,
            scholarshipName: scholarship.name,
            awardSummary: summary,
          }),
      });
      await emitEmailEvent("scholarship.submitted", {
        email: to.email,
        name: to.fullName,
        userId,
        dedupeSeed: `scholarship-submitted:${app.id}`,
        vars: {
          scholarship_name: scholarship.name,
          scholarship_kind: scholarship.kind,
          award_summary: summary,
          cohort_name: (await cohortName(admin, app.cohortId)) ?? "",
        },
      });
    }
  } catch (err) {
    console.error("[scholarships] submission email failed:", err);
  }

  try {
    await notify({
      userId,
      type: "scholarship_submitted",
      title: `Your ${scholarship.name} application is in`,
      body: "We read these by hand — you'll hear back either way.",
      link: "/dashboard/scholarships",
      dedupeKey: `scholarship-submitted:${app.id}`,
    });
  } catch (err) {
    console.error("[scholarships] submission notify failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Admin decisions
// ---------------------------------------------------------------------------

export type DecisionResult =
  | {
      ok: true;
      /** Set when the student had already paid and a refund is now owed. */
      refundDueCents: number;
    }
  | { ok: false; error: string };

/**
 * How much this student actually paid toward tuition, and how much of it has
 * already come back. Bounds the refund — see awardRefundCents.
 */
async function tuitionPayment(
  admin: SupabaseClient,
  userId: string,
  cohortId: string | null,
): Promise<{
  paymentId: string;
  paymentIntentId: string | null;
  amountCents: number;
  receiptUrl: string | null;
} | null> {
  let query = admin
    .from("payments")
    .select("id, stripe_payment_intent_id, amount_cents, stripe_receipt_url, status")
    .eq("user_id", userId)
    .eq("status", "succeeded");
  if (cohortId) query = query.eq("cohort_id", cohortId);

  const { data } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const row = data as Record<string, any>;
  return {
    paymentId: row.id,
    paymentIntentId: row.stripe_payment_intent_id ?? null,
    amountCents: normalizeCents(row.amount_cents),
    receiptUrl: row.stripe_receipt_url ?? null,
  };
}

/**
 * Award a scholarship.
 *
 * Deliberately does NOT move money. For a student who hasn't paid, the award
 * is the discount and checkout picks it up on its own. For one who has, this
 * records `fulfillment = 'refund_due'` and stops — an admin then presses the
 * refund button, which is the only thing in this file that calls Stripe. The
 * split exists because awarding and refunding are different decisions with
 * very different blast radii, and collapsing them into one click means a
 * misclick on a review screen moves real money off a real card.
 */
export async function awardScholarship(args: {
  applicationId: string;
  reviewerId: string;
  note?: string | null;
  /** Override the catalog amount for this one student, in cents. */
  overrideCents?: number | null;
  now?: Date;
}): Promise<DecisionResult> {
  const admin = createAdminClient();
  const now = args.now ?? new Date();

  const { data: row, error } = await admin
    .from("scholarship_applications")
    .select("*, scholarship:scholarships(*)")
    .eq("id", args.applicationId)
    .maybeSingle();
  if (error || !row) return { ok: false, error: "That application doesn't exist." };

  const app = mapScholarshipApplication(row as Record<string, any>);
  const scholarshipRow = (row as Record<string, any>).scholarship;
  if (!scholarshipRow) {
    return { ok: false, error: "That scholarship has been deleted." };
  }
  const scholarship = mapScholarship(scholarshipRow);

  const [counts, others] = await Promise.all([
    awardedCounts(admin),
    listApplicationsForUser(admin, app.userId),
  ]);
  const otherLive = others
    .filter((o) => o.id !== app.id)
    .map((o) => o.status)
    .filter(
      (s): s is ScholarshipAppStatus =>
        s === "submitted" || s === "under_review" || s === "awarded",
    );

  const guard = canAward({
    status: app.status,
    otherLiveStatuses: otherLive,
    seats: scholarship.seats,
    awardedCount: counts.get(scholarship.id) ?? 0,
  });
  if (!guard.ok) return { ok: false, error: guard.error };

  const payment = await tuitionPayment(admin, app.userId, app.cohortId);
  const hasPaid = !!payment && payment.amountCents > 0;

  // The terms, with any per-student override folded in. An override is a flat
  // cents figure, so it replaces the percentage too — a reviewer typing a
  // number means that number.
  const terms: AwardTerms =
    args.overrideCents != null && args.overrideCents >= 0
      ? {
          ...scholarship.terms,
          amountCents: normalizeCents(args.overrideCents),
          percent: null,
        }
      : scholarship.terms;

  // Snapshot what the award is worth. For a student who has paid, that's
  // bounded by what they paid; for one who hasn't, by the cohort list price —
  // checkout re-resolves a percentage against the real price at the till, so
  // this figure is a record and a display value, not the final word.
  const listPrice = hasPaid ? payment.amountCents : await cohortPriceCents(admin, app.cohortId);
  const awardCents =
    terms.awardType === "discount"
      ? hasPaid
        ? awardRefundCents(terms, payment.amountCents, app.refundedCents)
        : awardDiscountCents(terms, listPrice)
      : 0;

  const fulfillment = fulfillmentFor(terms, {
    hasPaid,
    refundedCents: app.refundedCents,
  });

  const { error: updateErr } = await admin
    .from("scholarship_applications")
    .update({
      status: "awarded",
      award_cents: awardCents,
      mentor_calls_awarded: normalizeMentorCalls(terms.mentorCalls),
      fulfillment,
      decision_note: args.note?.trim() || null,
      reviewed_by: args.reviewerId,
      reviewed_at: now.toISOString(),
      decided_at: now.toISOString(),
    })
    .eq("id", app.id)
    // Conditional so two reviewers pressing Award at the same moment can't
    // both succeed and double-count a seat.
    .in("status", ["submitted", "under_review", "declined"]);

  if (updateErr) {
    if (/duplicate key|unique constraint/i.test(updateErr.message)) {
      return {
        ok: false,
        error:
          "This student already holds another scholarship. Revoke that one first.",
      };
    }
    console.error("[scholarships] award failed:", updateErr.message);
    return { ok: false, error: "Couldn't record that award. Try again." };
  }

  await announceAward({
    userId: app.userId,
    applicationId: app.id,
    scholarship,
    terms,
    awardCents,
    refund: fulfillment === "refund_due",
    note: args.note ?? null,
    cohortId: app.cohortId,
  });

  return { ok: true, refundDueCents: fulfillment === "refund_due" ? awardCents : 0 };
}

async function cohortPriceCents(
  admin: SupabaseClient,
  cohortId: string | null,
): Promise<number> {
  if (!cohortId) return 13000;
  const { data } = await admin
    .from("cohorts")
    .select("price_cents")
    .eq("id", cohortId)
    .maybeSingle();
  return normalizeCents((data as any)?.price_cents) || 13000;
}

async function announceAward(args: {
  userId: string;
  applicationId: string;
  scholarship: Scholarship;
  terms: AwardTerms;
  awardCents: number;
  refund: boolean;
  note: string | null;
  cohortId: string | null;
}) {
  const admin = createAdminClient();
  const summary = describeAward(args.terms);
  const isCalls = args.terms.awardType === "mentor_calls";

  try {
    const to = await loadRecipient(admin, args.userId);
    if (to.email) {
      if (isCalls) {
        const calls = normalizeMentorCalls(args.terms.mentorCalls);
        await sendTemplated(SCHOLARSHIP_AWARDED_CALLS_TEMPLATE, {
          to: to.email,
          toName: to.fullName,
          userId: args.userId,
          vars: {
            scholarship_name: args.scholarship.name,
            calls: String(calls),
            note: args.note ?? "",
          },
          dedupeKey: `scholarship-awarded:${args.applicationId}`,
          fallback: () =>
            Templates.scholarshipAwardedCalls({
              name: to.fullName,
              scholarshipName: args.scholarship.name,
              calls,
              note: args.note,
            }),
        });
      } else {
        const amount = formatMoney(args.awardCents);
        // The one sentence that tells them what actually happens next. Built
        // here rather than in the template so the database copy and the
        // compiled fallback can't drift on the detail that matters most.
        const fulfillmentLine = args.refund
          ? `${amount} is being refunded to the card you paid with. Refunds usually land in 5–10 business days. Your enrollment is unchanged.`
          : `Your tuition is now ${amount} lower. You don't need a code — the new price is already applied when you go to pay.`;
        await sendTemplated(SCHOLARSHIP_AWARDED_TEMPLATE, {
          to: to.email,
          toName: to.fullName,
          userId: args.userId,
          vars: {
            scholarship_name: args.scholarship.name,
            award_summary: summary,
            amount,
            fulfillment_line: fulfillmentLine,
            note: args.note ?? "",
          },
          dedupeKey: `scholarship-awarded:${args.applicationId}`,
          fallback: () =>
            Templates.scholarshipAwarded({
              name: to.fullName,
              scholarshipName: args.scholarship.name,
              awardSummary: summary,
              amountCents: args.awardCents,
              refund: args.refund,
              note: args.note,
            }),
        });
      }

      await emitEmailEvent("scholarship.awarded", {
        email: to.email,
        name: to.fullName,
        userId: args.userId,
        dedupeSeed: `scholarship-awarded:${args.applicationId}`,
        vars: {
          scholarship_name: args.scholarship.name,
          scholarship_kind: args.scholarship.kind,
          award_summary: summary,
          amount: isCalls ? "" : formatMoney(args.awardCents),
          calls: isCalls ? String(normalizeMentorCalls(args.terms.mentorCalls)) : "",
          cohort_name: (await cohortName(admin, args.cohortId)) ?? "",
        },
      });
    }
  } catch (err) {
    console.error("[scholarships] award email failed:", err);
  }

  try {
    await notify({
      userId: args.userId,
      type: "scholarship_awarded",
      title: `You got the ${args.scholarship.name}`,
      body: summary,
      link: "/dashboard/scholarships",
      dedupeKey: `scholarship-awarded:${args.applicationId}`,
    });
  } catch (err) {
    console.error("[scholarships] award notify failed:", err);
  }
}

/** Decline an application. Always emails — see the template's note on silence. */
export async function declineScholarship(args: {
  applicationId: string;
  reviewerId: string;
  note?: string | null;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const now = args.now ?? new Date();

  const { data: row } = await admin
    .from("scholarship_applications")
    .select("*, scholarship:scholarships(*)")
    .eq("id", args.applicationId)
    .maybeSingle();
  if (!row) return { ok: false, error: "That application doesn't exist." };

  const app = mapScholarshipApplication(row as Record<string, any>);
  const scholarshipRow = (row as Record<string, any>).scholarship;
  const scholarship = scholarshipRow ? mapScholarship(scholarshipRow) : null;

  // Declining an awarded application would strand money: the discount is live
  // at checkout, or a refund is owed. Revoking is a separate, deliberate act.
  if (app.status === "awarded") {
    return {
      ok: false,
      error: "This application is awarded. Revoke the award before declining it.",
    };
  }

  const { data: updated, error } = await admin
    .from("scholarship_applications")
    .update({
      status: "declined",
      decision_note: args.note?.trim() || null,
      reviewed_by: args.reviewerId,
      reviewed_at: now.toISOString(),
      decided_at: now.toISOString(),
    })
    .eq("id", app.id)
    .in("status", ["submitted", "under_review"])
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[scholarships] decline failed:", error.message);
    return { ok: false, error: "Couldn't record that decision. Try again." };
  }
  if (!updated) {
    return { ok: false, error: "That application isn't awaiting a decision." };
  }

  try {
    const to = await loadRecipient(admin, app.userId);
    if (to.email && scholarship) {
      // Is anything else still open to them? Drives whether the email offers a
      // next step or just closes the loop kindly.
      const { cards } = await loadScholarshipCards(admin, app.userId, now);
      const canReapply = cards.some(
        (c) => c.scholarship.id !== scholarship.id && c.eligibility.ok,
      );

      await sendTemplated(SCHOLARSHIP_DECLINED_TEMPLATE, {
        to: to.email,
        toName: to.fullName,
        userId: app.userId,
        vars: {
          scholarship_name: scholarship.name,
          note: args.note ?? "",
        },
        dedupeKey: `scholarship-declined:${app.id}`,
        fallback: () =>
          Templates.scholarshipDeclined({
            name: to.fullName,
            scholarshipName: scholarship.name,
            note: args.note ?? null,
            canReapply,
          }),
      });
      await emitEmailEvent("scholarship.declined", {
        email: to.email,
        name: to.fullName,
        userId: app.userId,
        dedupeSeed: `scholarship-declined:${app.id}`,
        vars: {
          scholarship_name: scholarship.name,
          scholarship_kind: scholarship.kind,
          award_summary: describeAward(scholarship.terms),
          cohort_name: (await cohortName(admin, app.cohortId)) ?? "",
        },
      });
    }
  } catch (err) {
    console.error("[scholarships] decline email failed:", err);
  }

  try {
    await notify({
      userId: app.userId,
      type: "scholarship_declined",
      title: `About your ${scholarship?.name ?? "scholarship"} application`,
      body: "We weren't able to award it this time. Your place is unaffected.",
      link: "/dashboard/scholarships",
      dedupeKey: `scholarship-declined:${app.id}`,
    });
  } catch (err) {
    console.error("[scholarships] decline notify failed:", err);
  }

  return { ok: true };
}

/**
 * Take an award back.
 *
 * Refuses once money has actually moved. A refunded award can't be un-refunded
 * by flipping a status column — the cash is gone, and pretending otherwise
 * would leave the ledger describing a world that doesn't exist. Undoing that
 * is a payments-side job (/admin/payments), deliberately not reachable from a
 * scholarship screen.
 */
export async function revokeScholarshipAward(args: {
  applicationId: string;
  reviewerId: string;
  note?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = createAdminClient();

  const { data: row } = await admin
    .from("scholarship_applications")
    .select("*")
    .eq("id", args.applicationId)
    .maybeSingle();
  if (!row) return { ok: false, error: "That application doesn't exist." };
  const app = mapScholarshipApplication(row as Record<string, any>);

  if (app.status !== "awarded") {
    return { ok: false, error: "That application isn't awarded." };
  }
  if (app.refundedCents > 0 || app.stripeRefundId) {
    return {
      ok: false,
      error:
        "This award was already refunded to the student's card. Handle the reversal in /admin/payments — it can't be undone from here.",
    };
  }
  if (app.credits.used > 0) {
    return {
      ok: false,
      error: `This student has already used ${app.credits.used} of their mentor calls. Revoking would leave the record wrong.`,
    };
  }

  const { error } = await admin
    .from("scholarship_applications")
    .update({
      status: "under_review",
      award_cents: 0,
      mentor_calls_awarded: 0,
      fulfillment: "none",
      decision_note: args.note?.trim() || app.decisionNote,
      reviewed_by: args.reviewerId,
      decided_at: null,
    })
    .eq("id", app.id)
    .eq("status", "awarded");

  if (error) {
    console.error("[scholarships] revoke failed:", error.message);
    return { ok: false, error: "Couldn't revoke that award. Try again." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The refund button — the only thing here that moves money
// ---------------------------------------------------------------------------

export type RefundResult =
  | { ok: true; refundId: string; amountCents: number }
  | { ok: false; error: string };

/**
 * Issue the partial Stripe refund for an award to a student who already paid.
 *
 * Safe to sit alongside enrolment because a PARTIAL refund does not revoke it:
 * handleChargeRefunded (lib/stripe-fulfillment.ts) only tears down `payments`,
 * `applications.status` and the `enrollments` row when `charge.refunded` is
 * true, which Stripe sets only once the WHOLE amount is back. This function
 * refunds strictly less than the charge — awardRefundCents caps at what was
 * paid minus what has already come back — so the webhook that follows records
 * the refund and announces it without touching the student's place in the
 * cohort. If that invariant ever changes, this stops being safe.
 *
 * Idempotent against a double-click: the update is conditional on
 * `stripe_refund_id is null`, and it is taken BEFORE the Stripe call. A crash
 * between the two leaves a claimed row with no refund, which shows up as a
 * stuck award an admin can see — strictly better than the inverse, where a
 * retry refunds a card twice.
 */
export async function issueScholarshipRefund(args: {
  applicationId: string;
  reviewerId: string;
  now?: Date;
}): Promise<RefundResult> {
  const admin = createAdminClient();
  const now = args.now ?? new Date();

  const { data: row } = await admin
    .from("scholarship_applications")
    .select("*, scholarship:scholarships(*)")
    .eq("id", args.applicationId)
    .maybeSingle();
  if (!row) return { ok: false, error: "That application doesn't exist." };

  const app = mapScholarshipApplication(row as Record<string, any>);
  const scholarshipRow = (row as Record<string, any>).scholarship;
  if (!scholarshipRow) return { ok: false, error: "That scholarship has been deleted." };
  const scholarship = mapScholarship(scholarshipRow);

  if (app.status !== "awarded") {
    return { ok: false, error: "Only an awarded scholarship can be refunded." };
  }
  if (app.stripeRefundId) {
    return { ok: false, error: "This award has already been refunded." };
  }
  if (scholarship.terms.awardType !== "discount") {
    return { ok: false, error: "This scholarship grants mentor calls, not money." };
  }

  const payment = await tuitionPayment(admin, app.userId, app.cohortId);
  if (!payment) {
    return {
      ok: false,
      error:
        "No completed tuition payment found for this student, so there's nothing to refund. Their award will come off checkout instead.",
    };
  }
  if (!payment.paymentIntentId) {
    return {
      ok: false,
      error: "That payment has no Stripe payment intent recorded — refund it from /admin/payments.",
    };
  }

  // Recomputed from the payment rather than trusted from award_cents, so a
  // refund can never exceed the charge it is issued against.
  const amountCents = awardRefundCents(
    { ...scholarship.terms, amountCents: app.awardCents, percent: scholarship.terms.percent },
    payment.amountCents,
    app.refundedCents,
  );
  if (amountCents <= 0) {
    return { ok: false, error: "There's nothing left to refund on this payment." };
  }
  if (amountCents >= payment.amountCents) {
    // A refund equal to the charge makes Stripe set charge.refunded = true,
    // and the webhook would then delete the enrollment and roll the student
    // back to "accepted" — silently un-enrolling someone we just gave a full
    // scholarship to. Route a full ride through /admin/payments, where that
    // consequence is the point rather than a surprise.
    return {
      ok: false,
      error:
        "That's the full amount they paid. A full refund would cancel their enrollment — issue it from /admin/payments if that's what you mean.",
    };
  }

  // Claim first. See the idempotency note above.
  const claimId = `pending:${app.id}:${now.getTime()}`;
  const { data: claimed, error: claimErr } = await admin
    .from("scholarship_applications")
    .update({ stripe_refund_id: claimId })
    .eq("id", app.id)
    .is("stripe_refund_id", null)
    .select("id")
    .maybeSingle();
  if (claimErr) {
    console.error("[scholarships] refund claim failed:", claimErr.message);
    return { ok: false, error: "Couldn't start that refund. Try again." };
  }
  if (!claimed) {
    return { ok: false, error: "This award has already been refunded." };
  }

  let refundId: string;
  try {
    const refund = await stripe.refunds.create({
      payment_intent: payment.paymentIntentId,
      amount: amountCents,
      reason: "requested_by_customer",
      metadata: {
        scholarship_application_id: app.id,
        scholarship: scholarship.slug,
      },
    });
    refundId = refund.id;
  } catch (err: any) {
    // Release the claim so an admin can retry. Stripe rejected the call, so no
    // money moved — leaving the row claimed would strand the award.
    await admin
      .from("scholarship_applications")
      .update({ stripe_refund_id: null })
      .eq("id", app.id)
      .eq("stripe_refund_id", claimId);
    const message = err?.message ?? "Stripe refused the refund.";
    console.error("[scholarships] stripe refund failed:", message);
    return { ok: false, error: `Stripe refused the refund: ${message}` };
  }

  await admin
    .from("scholarship_applications")
    .update({
      stripe_refund_id: refundId,
      refunded_cents: app.refundedCents + amountCents,
      refunded_at: now.toISOString(),
      fulfillment: "refunded",
    })
    .eq("id", app.id);

  // Only now — the refund exists. An email that arrives before the money does
  // is the one thing worse than no email.
  try {
    const to = await loadRecipient(admin, app.userId);
    if (to.email) {
      await sendTemplated(SCHOLARSHIP_REFUNDED_TEMPLATE, {
        to: to.email,
        toName: to.fullName,
        userId: app.userId,
        vars: {
          amount: formatMoney(amountCents),
          scholarship_name: scholarship.name,
        },
        dedupeKey: `scholarship-refunded:${refundId}`,
        fallback: () =>
          Templates.scholarshipRefunded({
            name: to.fullName,
            scholarshipName: scholarship.name,
            amountCents,
            receiptUrl: payment.receiptUrl,
          }),
      });
    }
  } catch (err) {
    console.error("[scholarships] refund email failed:", err);
  }

  try {
    await notify({
      userId: app.userId,
      type: "scholarship_refunded",
      title: `${formatMoney(amountCents)} refunded`,
      body: `Your ${scholarship.name} award is on its way back to your card. Your enrollment is unchanged.`,
      link: "/dashboard/billing",
      dedupeKey: `scholarship-refunded:${refundId}`,
    });
  } catch (err) {
    console.error("[scholarships] refund notify failed:", err);
  }

  return { ok: true, refundId, amountCents };
}

// ---------------------------------------------------------------------------
// Inviting a student to apply
// ---------------------------------------------------------------------------

export async function inviteToScholarship(args: {
  userId: string;
  scholarshipId: string;
  note?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const scholarship = await getScholarshipById(admin, args.scholarshipId);
  if (!scholarship) return { ok: false, error: "That scholarship doesn't exist." };

  const to = await loadRecipient(admin, args.userId);
  if (!to.email) {
    return { ok: false, error: "That student has no email address on file." };
  }

  const summary = describeAward(scholarship.terms);
  const applyUrl = `${env.siteUrl}/dashboard/scholarships/${encodeURIComponent(scholarship.slug)}`;

  await sendTemplated(SCHOLARSHIP_INVITE_TEMPLATE, {
    to: to.email,
    toName: to.fullName,
    userId: args.userId,
    vars: {
      scholarship_name: scholarship.name,
      award_summary: summary,
      apply_url: applyUrl,
      note: args.note ?? "",
    },
    // One invite per student per scholarship — a nudge repeated is a nag.
    dedupeKey: `scholarship-invite:${scholarship.id}:${args.userId}`,
    fallback: () =>
      Templates.scholarshipInvite({
        name: to.fullName,
        scholarshipName: scholarship.name,
        awardSummary: summary,
        slug: scholarship.slug,
        note: args.note ?? null,
      }),
  });

  await notify({
    userId: args.userId,
    type: "scholarship_invite",
    title: `A scholarship you should look at`,
    body: `${scholarship.name} — ${summary}.`,
    link: `/dashboard/scholarships/${scholarship.slug}`,
    dedupeKey: `scholarship-invite:${scholarship.id}:${args.userId}`,
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Mentor-call credits (the learner's scholarship)
// ---------------------------------------------------------------------------

/**
 * The student's live mentor-call balance, or null if they hold no calls award.
 *
 * Read by /dashboard/calls and /dashboard/scholarships to decide whether to
 * offer the scholarship-funded booking path.
 */
export async function callCreditsForUser(
  client: SupabaseClient,
  userId: string,
): Promise<{ applicationId: string; scholarshipName: string; credits: CallCredits } | null> {
  const held = await getAwardForUser(client, userId);
  if (!held) return null;
  if (held.scholarship.terms.awardType !== "mentor_calls") return null;
  if (held.app.credits.granted <= 0) return null;
  return {
    applicationId: held.app.id,
    scholarshipName: held.scholarship.name,
    credits: held.app.credits,
  };
}

/**
 * Spend one credit, when the team schedules a scholarship-funded call.
 *
 * Counted at SCHEDULE time, not at request time. A student who asks for a call
 * the team never books hasn't used anything, and charging them for it would
 * quietly eat a grant they never received the benefit of.
 *
 * The increment is conditional on there being a credit left, so two staff
 * scheduling the same student's requests concurrently can't overspend the
 * grant. Returns false when the balance is already zero.
 */
export async function spendCallCredit(
  admin: SupabaseClient,
  scholarshipApplicationId: string,
): Promise<boolean> {
  const { data: row } = await admin
    .from("scholarship_applications")
    .select("mentor_calls_awarded, mentor_calls_used, status")
    .eq("id", scholarshipApplicationId)
    .maybeSingle();
  if (!row) return false;

  const r = row as Record<string, any>;
  if (r.status !== "awarded") return false;
  const credits = callCredits(r.mentor_calls_awarded, r.mentor_calls_used);
  if (credits.remaining <= 0) return false;

  const { data: updated } = await admin
    .from("scholarship_applications")
    .update({ mentor_calls_used: credits.used + 1 })
    .eq("id", scholarshipApplicationId)
    // Guards the race: if someone else incremented first, our expected value
    // no longer matches and this updates nothing.
    .eq("mentor_calls_used", credits.used)
    .lt("mentor_calls_used", credits.granted)
    .select("id")
    .maybeSingle();

  return !!updated;
}

/**
 * The scholarship award funding an interview request, or null.
 *
 * A separate, tolerant read rather than a column on the shared SELECT in
 * lib/interview-requests.ts. Naming `scholarship_application_id` there would
 * make every interview-request read ERROR on a database where 0071 hasn't run
 * — and since those reads power the student's calls page and the team's queue,
 * a deploy that outran `supabase db push` would take both down. Here the same
 * situation reads as "this call isn't scholarship-funded", which is the
 * conservative answer: it can under-count a credit for a few minutes, never
 * spend one that doesn't exist.
 */
export async function scholarshipApplicationIdForRequest(
  admin: SupabaseClient,
  requestId: string,
): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from("interview_requests")
      .select("scholarship_application_id")
      .eq("id", requestId)
      .maybeSingle();
    if (error) return null;
    return (data as any)?.scholarship_application_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Which of these interview requests are scholarship-funded, as a Set.
 *
 * Batched so the team's queue can badge every row without an N+1, mirroring
 * how lib/founder-pass.ts passHolderUserIds serves the pass badge. Tolerant in
 * the same way and for the same reason as the single read above.
 */
export async function scholarshipFundedRequestIds(
  admin: SupabaseClient,
  requestIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (requestIds.length === 0) return out;
  try {
    const { data, error } = await admin
      .from("interview_requests")
      .select("id, scholarship_application_id")
      .in("id", requestIds as string[])
      .not("scholarship_application_id", "is", null);
    if (error || !data) return out;
    for (const row of data as Array<{ id: string }>) out.add(row.id);
  } catch {
    // Column absent (0071 not applied). No badges; nothing else breaks.
  }
  return out;
}

/** Give a credit back when a scheduled scholarship call is cancelled. */
export async function refundCallCredit(
  admin: SupabaseClient,
  scholarshipApplicationId: string,
): Promise<void> {
  const { data: row } = await admin
    .from("scholarship_applications")
    .select("mentor_calls_used")
    .eq("id", scholarshipApplicationId)
    .maybeSingle();
  if (!row) return;
  const used = Math.max(0, Math.floor(Number((row as any).mentor_calls_used) || 0));
  if (used <= 0) return;
  await admin
    .from("scholarship_applications")
    .update({ mentor_calls_used: used - 1 })
    .eq("id", scholarshipApplicationId)
    .eq("mentor_calls_used", used);
}

// ---------------------------------------------------------------------------
// The shared scholarship-interest block on /apply
// ---------------------------------------------------------------------------

/**
 * The questions shown to every applicant in the scholarship section of /apply.
 *
 * Separate from the per-scholarship questions on purpose: this block is asked
 * BEFORE anyone is accepted, so it can only ever flag interest ("would
 * financial help change whether you can do this?"). The real, scholarship-
 * specific questions come later, once there's a specific scholarship to answer
 * them about.
 *
 * Never throws — an unreadable config means the section simply doesn't render,
 * which must not be able to break the application form.
 */
export async function getScholarshipInterestQuestions(): Promise<CustomQuestion[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("site_settings")
      .select("value")
      .eq("key", SCHOLARSHIP_INTEREST_SETTING)
      .maybeSingle();
    return normalizeQuestions((data as any)?.value);
  } catch (err) {
    console.error("[scholarships] interest questions read failed:", err);
    return [];
  }
}

export {
  describeAward,
  formatMoney,
  stageOf,
  checkEligibility,
  callCredits,
};
