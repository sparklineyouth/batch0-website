import type { SupabaseClient } from "@supabase/supabase-js";
import { hasFounderPass, getPassTierForUser } from "@/lib/founder-pass";
import {
  DEFAULT_TIER,
  type PassTier,
} from "@/lib/founder-pass-tiers";
import {
  FEEDBACK_TOPICS,
  feedbackTopicLabel,
  type FeedbackTopic,
} from "@/lib/founder-pass-topics";

// Re-exported so server code keeps a single import site. Client components must
// import these straight from lib/founder-pass-topics — importing them from here
// would pull node:crypto (via founder-pass -> founder-pass-code) into the bundle.
export { FEEDBACK_TOPICS, feedbackTopicLabel };
export type { FeedbackTopic };

// Data layer for the four "tools" perks a founder pass unlocks (migration
// 0041): the editable public profile, the one-time feedback credit, the
// seven-day rebuild, and the shared business-day decision target.
//
// Everything here takes a service-role client (lib/supabase/admin.ts) and does
// its own authorization the way lib/founder-pass.ts does — founder_pass_* has
// no user-facing write policy by design, so the checks below ARE the access
// control. Do not import this into a client component.
//
// Every read tolerates migration 0041 not being applied yet: a missing table or
// column resolves to "no request" / "no rebuild" / "unavailable" rather than
// throwing, so /pass and /dashboard/application keep rendering on a database
// that is a deploy behind — the same contract 0040 established for redeemed_code.

// ---------------------------------------------------------------------------
// Errors we treat as "the migration hasn't landed" rather than real failures.
// PGRST205 = PostgREST schema cache miss (unknown table); 42P01 = undefined
// table; 42703 = undefined column.
// ---------------------------------------------------------------------------
function isMissingSchema(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  const code = error.code ?? "";
  return (
    code === "PGRST205" ||
    code === "42P01" ||
    code === "42703" ||
    /does not exist|schema cache/i.test(error.message ?? "")
  );
}

function isUniqueViolation(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  return (
    error.code === "23505" ||
    /duplicate key|unique constraint/i.test(error.message ?? "")
  );
}

// ===========================================================================
// Feedback credit
// ===========================================================================

const FEEDBACK_TOPIC_VALUES = new Set<string>(
  FEEDBACK_TOPICS.map((t) => t.value),
);

export type FeedbackStatus =
  | "requested"
  | "scheduled"
  | "delivered"
  | "declined";

export type FeedbackRequest = {
  id: string;
  userId: string;
  topic: FeedbackTopic;
  detail: string;
  linkUrl: string | null;
  status: FeedbackStatus;
  response: string | null;
  respondedAt: string | null;
  createdAt: string;
};

function mapFeedbackRow(row: any): FeedbackRequest {
  return {
    id: row.id,
    userId: row.user_id,
    topic: row.topic,
    detail: row.detail ?? "",
    linkUrl: row.link_url ?? null,
    status: row.status,
    response: row.response ?? null,
    respondedAt: row.responded_at ?? null,
    createdAt: row.created_at,
  };
}

/**
 * The holder's live feedback credit, if any. Returns the most recent non-
 * declined request (declined ones free the credit and shouldn't show as "your
 * request"). Null when they've never redeemed, or the table isn't there yet.
 */
export async function getFeedbackRequestForUser(
  client: SupabaseClient,
  userId: string,
): Promise<FeedbackRequest | null> {
  const { data, error } = await client
    .from("founder_pass_feedback_requests")
    .select("*")
    .eq("user_id", userId)
    .neq("status", "declined")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return mapFeedbackRow(data);
}

export type CreateFeedbackResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "no_pass"
        | "already_open" // one is in flight; finish it first
        | "spent" // the tier's lifetime credits are all used
        | "invalid"
        | "unavailable";
    };

/**
 * How many of this holder's credits are already committed.
 *
 * Counts every non-declined request: a delivered one has been spent, an open
 * one is being spent. Declined rows are excluded because a decline hands the
 * credit back — the same rule 0041's index encoded and 0055's comments carry
 * forward.
 *
 * Returns 0 when the table isn't there yet, matching this module's standing
 * contract that a missing migration reads as "nothing", never an exception.
 */
async function spentFeedbackCredits(
  client: SupabaseClient,
  userId: string,
): Promise<number> {
  const { count, error } = await client
    .from("founder_pass_feedback_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .neq("status", "declined");
  if (error) return 0;
  return count ?? 0;
}

/**
 * How many feedback credits this holder has left, and how many they started
 * with. Null when they hold no pass.
 *
 * Surfaced on /pass so "2 credits" is a number the holder can see going down,
 * rather than a claim in an email they have to take on trust.
 */
export async function feedbackCreditBalance(
  client: SupabaseClient,
  userId: string,
): Promise<{ total: number; spent: number; remaining: number } | null> {
  const tier = await getPassTierForUser(client, userId);
  if (!tier) return null;
  const spent = await spentFeedbackCredits(client, userId);
  return {
    total: tier.feedbackCredits,
    spent,
    remaining: Math.max(0, tier.feedbackCredits - spent),
  };
}

export async function createFeedbackRequest(
  client: SupabaseClient,
  args: { userId: string; topic: string; detail: string; linkUrl?: string | null },
): Promise<CreateFeedbackResult> {
  if (!FEEDBACK_TOPIC_VALUES.has(args.topic)) {
    return { ok: false, reason: "invalid" };
  }
  const tier = await getPassTierForUser(client, args.userId);
  if (!tier) {
    return { ok: false, reason: "no_pass" };
  }

  // The lifetime ceiling. Since 0055 the unique index only guards "one OPEN at
  // a time", so this check is what stops a two-credit holder filing a third.
  //
  // It is safe to check-then-insert here precisely because that index still
  // exists: a holder with a request already open is rejected by the database
  // no matter what this count said, so this code path only ever runs when
  // nothing of theirs is in flight — serially, by construction.
  if ((await spentFeedbackCredits(client, args.userId)) >= tier.feedbackCredits) {
    return { ok: false, reason: "spent" };
  }

  const { error } = await client.from("founder_pass_feedback_requests").insert({
    user_id: args.userId,
    topic: args.topic,
    detail: (args.detail ?? "").trim().slice(0, 4000),
    link_url: normalizeUrl(args.linkUrl),
  });

  if (!error) return { ok: true };
  if (isUniqueViolation(error)) return { ok: false, reason: "already_open" };
  if (isMissingSchema(error)) return { ok: false, reason: "unavailable" };
  throw new Error(error.message);
}

/**
 * Every feedback request that still needs a human — the admin inbox. Excludes
 * delivered/declined so the queue is exactly "what's outstanding". Returns []
 * (not an error) when the table isn't there yet.
 */
export async function listOpenFeedbackRequests(
  client: SupabaseClient,
): Promise<FeedbackRequest[]> {
  const { data, error } = await client
    .from("founder_pass_feedback_requests")
    .select("*")
    .in("status", ["requested", "scheduled"])
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return (data as any[]).map(mapFeedbackRow);
}

// ===========================================================================
// Seven-day rebuild
// ===========================================================================

export type RebuildStatus = "submitted" | "reviewing" | "reviewed";

export type Rebuild = {
  id: string;
  userId: string;
  applicationId: string | null;
  summary: string;
  linkUrl: string | null;
  status: RebuildStatus;
  createdAt: string;
};

function mapRebuildRow(row: any): Rebuild {
  return {
    id: row.id,
    userId: row.user_id,
    applicationId: row.application_id ?? null,
    summary: row.summary ?? "",
    linkUrl: row.link_url ?? null,
    status: row.status,
    createdAt: row.created_at,
  };
}

/** The holder's rebuild submission, if they've made one. Tolerates 0041 absent. */
export async function getRebuildForUser(
  client: SupabaseClient,
  userId: string,
): Promise<Rebuild | null> {
  const { data, error } = await client
    .from("founder_pass_rebuilds")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return mapRebuildRow(data);
}

export type CreateRebuildResult =
  | { ok: true }
  | {
      ok: false;
      reason: "no_pass" | "not_declined" | "already_submitted" | "invalid" | "unavailable";
    };

/**
 * Submit a rebuild. Guards: the user holds a live pass, their most recent
 * application was rejected (the rebuild re-opens a "no"), and they haven't
 * already spent their one shot. The one-per-user unique index is the real
 * backstop against a race; the read check is just for a clean message.
 */
export async function createRebuild(
  client: SupabaseClient,
  args: { userId: string; summary: string; linkUrl?: string | null },
): Promise<CreateRebuildResult> {
  const summary = (args.summary ?? "").trim();
  if (summary.length < 20) return { ok: false, reason: "invalid" };
  if (!(await hasFounderPass(client, args.userId))) {
    return { ok: false, reason: "no_pass" };
  }

  const { data: app } = await client
    .from("applications")
    .select("id, status")
    .eq("user_id", args.userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!app || (app as any).status !== "rejected") {
    return { ok: false, reason: "not_declined" };
  }

  const { error } = await client.from("founder_pass_rebuilds").insert({
    user_id: args.userId,
    application_id: (app as any).id,
    summary: summary.slice(0, 6000),
    link_url: normalizeUrl(args.linkUrl),
  });

  if (!error) return { ok: true };
  if (isUniqueViolation(error)) return { ok: false, reason: "already_submitted" };
  if (isMissingSchema(error)) return { ok: false, reason: "unavailable" };
  throw new Error(error.message);
}

/**
 * Mark any outstanding rebuild for this user as reviewed. Called best-effort
 * from decideApplication when a fresh decision lands, so a re-review closes the
 * loop on the submission. Swallows every error — a missing table or no rebuild
 * must never fail the decision itself.
 */
export async function markRebuildReviewedForUser(
  client: SupabaseClient,
  userId: string,
  reviewerId: string,
): Promise<void> {
  try {
    await client
      .from("founder_pass_rebuilds")
      .update({
        status: "reviewed",
        reviewed_by: reviewerId,
        reviewed_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .neq("status", "reviewed");
  } catch {
    /* best-effort */
  }
}

/** User ids with a rebuild still awaiting review — badges the admin queue. */
export async function pendingRebuildUserIds(
  client: SupabaseClient,
): Promise<Set<string>> {
  const out = new Set<string>();
  const { data, error } = await client
    .from("founder_pass_rebuilds")
    .select("user_id")
    .neq("status", "reviewed");
  if (error || !data) return out;
  for (const r of data as Array<{ user_id: string | null }>) {
    if (r.user_id) out.add(r.user_id);
  }
  return out;
}

// ===========================================================================
// Public profile
// ===========================================================================

export type UpdateProfileInput = {
  projectName?: string | null;
  bio?: string | null;
  websiteUrl?: string | null;
  demoUrl?: string | null;
  milestones?: string[];
  isPublic?: boolean;
};

export type UpdateProfileResult =
  | { ok: true }
  | { ok: false; reason: "no_pass" | "unavailable" };

/**
 * Write the holder's profile fields. Scoped by redeemed_by = userId on the
 * update itself, so a caller can never touch a pass that isn't theirs even
 * though this runs on the service-role client (RLS-bypassed). A live pass only
 * (revoked_at is null) — a killed card has no profile to edit.
 */
export async function updatePassProfile(
  client: SupabaseClient,
  userId: string,
  input: UpdateProfileInput,
): Promise<UpdateProfileResult> {
  const patch: Record<string, unknown> = {};
  if ("projectName" in input) patch.project_name = clampText(input.projectName, 120);
  if ("bio" in input) patch.founder_bio = clampText(input.bio, 600);
  if ("websiteUrl" in input) patch.website_url = normalizeUrl(input.websiteUrl);
  if ("demoUrl" in input) patch.demo_url = normalizeUrl(input.demoUrl);
  if ("milestones" in input) {
    patch.milestones = (input.milestones ?? [])
      .map((m) => (typeof m === "string" ? m.trim() : ""))
      .filter(Boolean)
      .slice(0, 8)
      .map((m) => m.slice(0, 140));
  }
  if ("isPublic" in input) patch.profile_public = input.isPublic === true;

  const { data, error } = await client
    .from("founder_passes")
    .update(patch)
    .eq("redeemed_by", userId)
    .is("revoked_at", null)
    .select("serial")
    .maybeSingle();

  if (error) {
    if (isMissingSchema(error)) return { ok: false, reason: "unavailable" };
    throw new Error(error.message);
  }
  if (!data) return { ok: false, reason: "no_pass" };
  return { ok: true };
}

// ===========================================================================
// Decision target (SLA)
// ===========================================================================

/**
 * The target we hold ourselves to for pass applications. Copy that references
 * it says "we aim to" — it is a target we track and surface, not an absolute
 * guarantee, because no code can force a human to decide on time. The admin
 * queue shows how a submitted pass app is tracking against it.
 */
export const FOUNDER_PASS_DECISION_TARGET_DAYS = DEFAULT_TIER.decisionTargetDays;

/**
 * Whole business days (Mon–Fri) elapsed between two instants. Approximate —
 * ignores holidays — which is fine for a soft "is this pass app overdue" nudge
 * in the admin queue, not a billing calculation.
 */
export function businessDaysBetween(start: Date, end: Date): number {
  if (!(end > start)) return 0;
  const MS_DAY = 86_400_000;
  const s = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const e = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const totalDays = Math.round((e - s) / MS_DAY);
  const fullWeeks = Math.floor(totalDays / 7);
  let business = fullWeeks * 5;
  const remaining = totalDays - fullWeeks * 7;
  let dow = new Date(s).getUTCDay();
  for (let i = 0; i < remaining; i++) {
    dow = (dow + 1) % 7;
    if (dow !== 0 && dow !== 6) business++;
  }
  return business;
}

/**
 * How a submitted pass application is tracking against its decision target.
 *
 * `tier` is optional and defaults to standard, so callers that don't know the
 * applicant's tier (or run on a pre-0055 database) get exactly the old
 * three-day behaviour. Pass it wherever the tier is already loaded — a
 * full-ride holder's application is late a lot sooner than a standard one's,
 * and a queue that doesn't say so is quietly missing the promise we made.
 *
 * `targetDays` comes back with the answer so the caller can render "2 of 1
 * business days" without re-deriving the number from the tier itself.
 */
export function decisionTargetStatus(
  submittedAt: string | null,
  now: Date = new Date(),
  tier: PassTier = DEFAULT_TIER,
): { businessDays: number; targetDays: number; overTarget: boolean } | null {
  if (!submittedAt) return null;
  const submitted = new Date(submittedAt);
  if (Number.isNaN(submitted.getTime())) return null;
  const businessDays = businessDaysBetween(submitted, now);
  return {
    businessDays,
    targetDays: tier.decisionTargetDays,
    overTarget: businessDays > tier.decisionTargetDays,
  };
}

// ---------------------------------------------------------------------------
// Small shared normalizers.
// ---------------------------------------------------------------------------
function clampText(v: string | null | undefined, max: number): string | null {
  const t = (v ?? "").trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Coerce user-typed links into something safe to render as an href. Adds a
 * https:// scheme when missing, and drops anything that isn't http(s) — a
 * `javascript:` or `data:` URL must never reach an anchor on the public
 * profile page.
 */
export function normalizeUrl(v: string | null | undefined): string | null {
  const raw = (v ?? "").trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString().slice(0, 500);
  } catch {
    return null;
  }
}
