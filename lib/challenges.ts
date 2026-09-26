import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createAdminClient,
  createPublicReadClient,
} from "@/lib/supabase/admin";
import {
  rowToChallenge,
  rowToSubmission,
  mergeQualifiedReferrals,
  shortName,
  type Challenge,
  type ChallengeSubmission,
  type PublicWinner,
  type ReferralSource,
} from "@/lib/challenges-shared";

// ---------------------------------------------------------------------------
// Challenges — SERVER data layer.
//
// Service-role reads. Pure types/helpers live in lib/challenges-shared.ts
// (client-safe) and are re-exported here so server callers can keep importing
// from "@/lib/challenges".
//
// Reads mirror getSiteConfig(): defensive parsing and NEVER throw — a
// malformed row can degrade a challenge but can't crash the marquee, the index
// or an event page.
// ---------------------------------------------------------------------------

export * from "@/lib/challenges-shared";

/**
 * The live challenge for the homepage marquee and the student Home row.
 * Several can be live at once now; this picks one — an admin-featured one
 * first, then whichever closes soonest (the most urgent deadline).
 *
 * Public read: same data for every visitor, so it goes through the cacheable
 * client. The no-store admin client here would force the homepage to render
 * per-request.
 */
export async function getActiveChallenge(): Promise<Challenge | null> {
  try {
    const db = createPublicReadClient();
    const { data } = await db
      .from("challenges")
      .select("*")
      .eq("status", "active")
      .order("featured", { ascending: false })
      .order("closes_at", { ascending: true, nullsFirst: false })
      .limit(5);
    const now = Date.now();
    const rows = (data ?? []).map(rowToChallenge);
    // Skip one that's past its deadline but not yet closed by an admin — the
    // marquee shouldn't advertise a form that won't accept anything.
    return (
      rows.find((c) => !c.closesAt || new Date(c.closesAt).getTime() > now) ??
      null
    );
  } catch (err) {
    console.error("[challenges] getActiveChallenge failed:", err);
    return null;
  }
}

export type ChallengeListItem = Challenge & { registrationCount: number };

/** Every published (active or closed) challenge, with registration counts,
 *  for the public index. Cacheable — the index is prerendered. */
export async function getPublicChallenges(): Promise<ChallengeListItem[]> {
  try {
    const db = createPublicReadClient();
    const { data } = await db
      .from("challenges")
      .select("*, registrations:challenge_registrations(count)")
      .in("status", ["active", "closed"])
      .order("created_at", { ascending: false })
      .limit(60);
    return (data ?? []).map((r: any) => ({
      ...rowToChallenge(r),
      registrationCount: Array.isArray(r.registrations)
        ? (r.registrations[0]?.count ?? 0)
        : 0,
    }));
  } catch (err) {
    console.error("[challenges] getPublicChallenges failed:", err);
    return [];
  }
}

/** A challenge by slug — any non-archived status. Null if missing/archived. */
export async function getChallengeBySlug(
  slug: string,
): Promise<Challenge | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("challenges")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();
    if (!data || data.status === "archived") return null;
    return rowToChallenge(data);
  } catch (err) {
    console.error("[challenges] getChallengeBySlug failed:", err);
    return null;
  }
}

/** Any challenge by id, any status — for the admin editor. */
export async function getChallengeById(id: string): Promise<Challenge | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("challenges")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    return data ? rowToChallenge(data) : null;
  } catch (err) {
    console.error("[challenges] getChallengeById failed:", err);
    return null;
  }
}

export async function getRegistrationCount(challengeId: string): Promise<number> {
  try {
    const admin = createAdminClient();
    const { count } = await admin
      .from("challenge_registrations")
      .select("id", { count: "exact", head: true })
      .eq("challenge_id", challengeId);
    return count ?? 0;
  } catch {
    return 0;
  }
}

export type EntrantState = {
  registered: boolean;
  registeredAt: string | null;
  submission: ChallengeSubmission | null;
  referralCode: string | null;
  fullName: string | null;
};

/** Everything the event + submit pages need to know about one viewer. */
export async function getEntrantState(
  challengeId: string,
  userId: string,
): Promise<EntrantState> {
  const admin = createAdminClient();
  const [{ data: reg }, { data: sub }, { data: profile }] = await Promise.all([
    admin
      .from("challenge_registrations")
      .select("created_at")
      .eq("challenge_id", challengeId)
      .eq("user_id", userId)
      .maybeSingle(),
    admin
      .from("challenge_submissions")
      .select("*")
      .eq("challenge_id", challengeId)
      .eq("user_id", userId)
      .maybeSingle(),
    admin
      .from("profiles")
      .select("referral_code, full_name")
      .eq("id", userId)
      .maybeSingle(),
  ]);
  return {
    // A submission implies registration even if the row predates 0085.
    registered: !!reg || !!sub,
    registeredAt: (reg as any)?.created_at ?? null,
    submission: sub ? rowToSubmission(sub) : null,
    referralCode: ((profile as any)?.referral_code as string | null) ?? null,
    fullName: ((profile as any)?.full_name as string | null) ?? null,
  };
}

export type ReferralFriend = {
  name: string;
  source: ReferralSource;
  at: string;
};

export type ReferralProgress = {
  required: number;
  count: number;
  friends: ReferralFriend[];
};

/**
 * Who `referrerId` has brought in, for the purposes of THIS challenge's
 * referrals_required gate. A friend qualifies when they have an account and,
 * through the referrer's link, either registered for this challenge or
 * submitted a cohort application — on or after the challenge was created. See
 * mergeQualifiedReferrals for the dedupe rules.
 */
export async function getReferralProgress(
  challenge: Pick<Challenge, "id" | "createdAt" | "referralsRequired">,
  referrerId: string,
  referralCode: string | null,
  client?: SupabaseClient,
): Promise<ReferralProgress> {
  const empty = {
    required: challenge.referralsRequired,
    count: 0,
    friends: [],
  };
  const code = (referralCode ?? "").trim().toLowerCase();
  if (!code) return empty;
  try {
    const admin = client ?? createAdminClient();
    const [{ data: regs }, { data: apps }] = await Promise.all([
      admin
        .from("challenge_registrations")
        .select("user_id, created_at")
        .eq("challenge_id", challenge.id)
        .eq("referral_code", code)
        .limit(500),
      admin
        .from("applications")
        .select("user_id, submitted_at")
        .eq("referral_code", code)
        .neq("status", "draft")
        .not("submitted_at", "is", null)
        .gte("submitted_at", challenge.createdAt)
        .limit(500),
    ]);
    const merged = mergeQualifiedReferrals(
      {
        registrations: (regs ?? []) as any[],
        applications: (apps ?? []) as any[],
      },
      { referrerId, since: challenge.createdAt },
    );
    let names = new Map<string, string>();
    if (merged.length) {
      const { data: profs } = await admin
        .from("profiles")
        .select("id, full_name")
        .in(
          "id",
          merged.map((m) => m.userId),
        );
      names = new Map(
        (profs ?? []).map((p: any) => [p.id as string, shortName(p.full_name)]),
      );
    }
    return {
      required: challenge.referralsRequired,
      count: merged.length,
      friends: merged.map((m) => ({
        name: names.get(m.userId) ?? "A friend",
        source: m.source,
        at: m.at,
      })),
    };
  } catch (err) {
    console.error("[challenges] getReferralProgress failed:", err);
    return empty;
  }
}

/** Curated, PII-safe winners for the public strip and event pages. */
export async function getPublicWinners(
  opts: { challengeSlug?: string; limit?: number } = {},
): Promise<PublicWinner[]> {
  try {
    // Public, identical for every visitor — cacheable client, see above.
    const db = createPublicReadClient();
    let q = db
      .from("challenge_winners_public")
      .select("*")
      .order("funded_at", { ascending: false, nullsFirst: false })
      .limit(opts.limit ?? 8);
    if (opts.challengeSlug) q = q.eq("challenge_slug", opts.challengeSlug);
    const { data } = await q;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      challengeSlug: r.challenge_slug,
      challengeTitle: r.challenge_title,
      publicName: r.public_name ?? null,
      publicBlurb: r.public_blurb ?? null,
      publicProjectUrl: r.public_project_url ?? null,
      payoutAmountCents:
        typeof r.payout_amount_cents === "number"
          ? r.payout_amount_cents
          : null,
      awardLabel: r.award_label ?? null,
      fundedAt: r.funded_at ?? null,
    }));
  } catch (err) {
    console.error("[challenges] getPublicWinners failed:", err);
    return [];
  }
}
