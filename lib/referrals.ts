import type { SupabaseClient } from "@supabase/supabase-js";

export type ReferrerRow = {
  userId: string | null;
  referralCode: string;
  fullName: string | null;
  email: string | null;
  counts: {
    applied: number;
    accepted: number;
    paidOrEnrolled: number;
    rejected: number;
  };
};

/** The person behind a referral code. */
export type Referrer = {
  userId: string;
  fullName: string | null;
  email: string | null;
};

/**
 * Resolve referral codes to the students who own them.
 *
 * Codes are stored lowercase on `applications.referral_code` (see
 * app/apply/actions.ts) and on `profiles.referral_code`, so both sides are
 * compared lowercase here rather than trusting the caller.
 *
 * Returns a Map keyed by code. Codes with no matching profile are simply
 * absent — a referral code can outlive the account that created it, and the
 * caller should treat "referred by someone we can't name" as still referred.
 */
export async function resolveReferrersByCode(
  client: SupabaseClient,
  codes: string[],
): Promise<Map<string, Referrer>> {
  const unique = Array.from(
    new Set(codes.filter(Boolean).map((c) => c.toLowerCase())),
  );
  if (unique.length === 0) return new Map();

  const { data } = await client
    .from("profiles")
    .select("id, full_name, email, referral_code")
    .in("referral_code", unique);

  const out = new Map<string, Referrer>();
  for (const p of (data ?? []) as Array<{
    id: string;
    full_name: string | null;
    email: string | null;
    referral_code: string | null;
  }>) {
    if (!p.referral_code) continue;
    out.set(p.referral_code.toLowerCase(), {
      userId: p.id,
      fullName: p.full_name,
      email: p.email,
    });
  }
  return out;
}

export type ReferralCounts = ReferrerRow["counts"];

/**
 * Tally every application by the referral code that brought it in.
 *
 * Aggregation is JS-side rather than SQL because Supabase PostgREST can't
 * express "group by + aggregate by status" without an RPC. For cohort sizes in
 * the hundreds-of-applications range this is fine; if it grows past that, swap
 * to a materialized view or a database function.
 *
 * Deliberately unfiltered by status/cohort: this is "how many people has this
 * student brought in, ever". Callers showing it next to a status-filtered list
 * still want the person's true total, not the total within the current filter.
 *
 * Anonymous applications (no referral_code) are excluded entirely.
 */
export async function tallyApplicationsByReferralCode(
  client: SupabaseClient,
): Promise<Map<string, ReferralCounts>> {
  const { data: apps, error } = await client
    .from("applications")
    .select("referral_code, status")
    .not("referral_code", "is", null);
  if (error) throw new Error(error.message);

  const buckets = new Map<string, ReferralCounts>();
  for (const a of (apps ?? []) as Array<{
    referral_code: string;
    status: string;
  }>) {
    const code = a.referral_code.toLowerCase();
    const b = buckets.get(code) ?? {
      applied: 0,
      accepted: 0,
      paidOrEnrolled: 0,
      rejected: 0,
    };
    b.applied++;
    if (a.status === "accepted") b.accepted++;
    if (a.status === "paid" || a.status === "enrolled") b.paidOrEnrolled++;
    if (a.status === "rejected") b.rejected++;
    buckets.set(code, b);
  }
  return buckets;
}

/**
 * Aggregates applications by referral_code into a leaderboard.
 */
export async function computeReferralLeaderboard(
  client: SupabaseClient,
  limit = 25,
): Promise<ReferrerRow[]> {
  const buckets = await tallyApplicationsByReferralCode(client);

  const codes = Array.from(buckets.keys());
  if (codes.length === 0) return [];

  const referrerByCode = await resolveReferrersByCode(client, codes);

  const rows: ReferrerRow[] = codes.map((code) => {
    const profile = referrerByCode.get(code);
    return {
      userId: profile?.userId ?? null,
      referralCode: code,
      fullName: profile?.fullName ?? null,
      email: profile?.email ?? null,
      counts: buckets.get(code)!,
    };
  });

  // Primary sort by paid/enrolled (the actual program contribution),
  // tiebreak on accepted, then on raw applied.
  rows.sort((a, b) => {
    if (b.counts.paidOrEnrolled !== a.counts.paidOrEnrolled) {
      return b.counts.paidOrEnrolled - a.counts.paidOrEnrolled;
    }
    if (b.counts.accepted !== a.counts.accepted) {
      return b.counts.accepted - a.counts.accepted;
    }
    return b.counts.applied - a.counts.applied;
  });

  return rows.slice(0, limit);
}
