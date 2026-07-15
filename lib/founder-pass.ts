import type { SupabaseClient } from "@supabase/supabase-js";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  hashPassCode,
  normalizePassCode,
  requirePepper,
} from "@/lib/founder-pass-code";

// Founder-pass reads and the redemption write.
//
// Everything here takes a service-role client (lib/supabase/admin.ts).
// founder_passes has no user-facing insert/update policy by design — see
// supabase/migrations/0039_founder_passes.sql — so redemption necessarily
// runs server-side with RLS bypassed, and the checks below ARE the access
// control. Do not import this into a client component.

/**
 * The optional public founder profile a holder writes on their pass
 * (migration 0041). Every field is null/empty until the holder fills it in,
 * and `public` gates the rich block on /pass/[serial] — the ticket itself is
 * public the moment a card is claimed, the profile only when published.
 */
export type PassProfile = {
  projectName: string | null;
  bio: string | null;
  websiteUrl: string | null;
  demoUrl: string | null;
  milestones: string[];
  public: boolean;
};

/** A pass as its holder sees it. */
export type FounderPass = {
  serial: number;
  redeemedAt: string | null;
  batch: string;
  /**
   * The plaintext code, captured at redemption (migration 0040). Null for
   * passes redeemed before that migration — the ticket falls back to the
   * serial. Safe to show once redeemed: a claimed code is inert, and revoke
   * (the only admin action) is permanent. See 0040 for the full argument.
   */
  redeemedCode: string | null;
  /**
   * The holder's editable profile (migration 0041). Fields read as null/[]
   * /false on a database where 0041 hasn't run — getPassForUser select("*")
   * simply won't return the columns, and the mapping below defaults them.
   */
  profile: PassProfile;
};

/**
 * A founder_passes row as read via select("*"). Profile columns are optional so
 * the shape still matches on a database where migration 0041 hasn't run.
 */
export type PassRow = {
  serial: number;
  redeemed_at: string | null;
  batch: string;
  redeemed_by?: string | null;
  redeemed_code?: string | null;
  project_name?: string | null;
  founder_bio?: string | null;
  website_url?: string | null;
  demo_url?: string | null;
  milestones?: unknown;
  profile_public?: boolean | null;
};

/** Map the profile columns off a founder_passes row, tolerating their absence. */
function mapPassProfile(row: {
  project_name?: string | null;
  founder_bio?: string | null;
  website_url?: string | null;
  demo_url?: string | null;
  milestones?: unknown;
  profile_public?: boolean | null;
}): PassProfile {
  return {
    projectName: row.project_name ?? null,
    bio: row.founder_bio ?? null,
    websiteUrl: row.website_url ?? null,
    demoUrl: row.demo_url ?? null,
    milestones: Array.isArray(row.milestones)
      ? (row.milestones as unknown[]).filter(
          (m): m is string => typeof m === "string",
        )
      : [],
    public: row.profile_public === true,
  };
}

/**
 * Tuition discount for pass holders, in cents. Applied server-side at
 * checkout (app/api/stripe/checkout) and echoed everywhere a price is shown
 * to an accepted holder (dashboard, acceptance email) so the number they
 * read is the number they pay. Flat rather than a percentage so the perk is
 * one honest sentence: "$30 off tuition."
 */
export const FOUNDER_PASS_TUITION_DISCOUNT_CENTS = 3000;

export type RedeemResult =
  | { ok: true; serial: number }
  | {
      ok: false;
      reason:
        | "invalid" // no live pass with that code
        | "already_redeemed" // valid code, but someone already claimed it
        | "revoked" // valid code, but we killed this card
        | "already_have_pass" // this account already holds a different pass
        | "rate_limited"; // too many recent attempts
    };

// Rate limits. The code space is small (6-8 chars), so these are the primary
// defence, not a nicety — see the SECURITY note in lib/founder-pass-code.ts.
//
// Two axes, because either alone is trivially sidestepped: a per-account limit
// falls to someone minting throwaway signups, and a per-IP limit falls to
// anyone with a proxy pool. Together they make both evasions cost something.
//
// Tighter than the app's other limits (apply-draft is 30/min) because the
// shape of the action is different: a real holder types one code, once. There
// is no legitimate reason to attempt this ten times in an hour, so a low
// ceiling costs honest users nothing.
const USER_LIMIT = 5;
const IP_LIMIT = 20;
const WINDOW_SECONDS = 60 * 60;

/**
 * Redeem a code for a user, binding the physical card to their account.
 *
 * The claim is a single conditional UPDATE (`... where code_hash = ? and
 * redeemed_by is null and revoked_at is null`) rather than a select-then-
 * update. That matters: two requests racing on the same code would both pass a
 * read check and the second would silently overwrite the first, handing one
 * card to two accounts. As one statement, Postgres serialises them and exactly
 * one comes back with a row.
 */
export async function redeemPass(
  client: SupabaseClient,
  args: { userId: string; rawCode: string; ip: string | null },
): Promise<RedeemResult> {
  const { userId, rawCode, ip } = args;

  // Reuses the atomic Postgres limiter from 0005 (lib/rate-limit.ts) rather
  // than counting rows here: a count-then-write check is not atomic and races
  // under exactly the concurrent load an attacker produces.
  //
  // Note checkRateLimit fails OPEN on database trouble. That is the right call
  // for login, and it is harmless here for a reason worth writing down: the
  // limiter and founder_passes live in the same database, so if it is unwell
  // enough to fail the limiter, the redeeming UPDATE below cannot succeed
  // either. Failing open widens the guess window, never the grant.
  const [byUser, byIp] = await Promise.all([
    checkRateLimit({
      kind: "founder-pass-redeem",
      identifier: userId,
      limit: USER_LIMIT,
      windowSeconds: WINDOW_SECONDS,
    }),
    ip
      ? checkRateLimit({
          kind: "founder-pass-redeem-ip",
          identifier: ip,
          limit: IP_LIMIT,
          windowSeconds: WINDOW_SECONDS,
        })
      : Promise.resolve({ ok: true, count: 0, limit: IP_LIMIT }),
  ]);
  if (!byUser.ok || !byIp.ok) return { ok: false, reason: "rate_limited" };

  const code = normalizePassCode(rawCode);
  if (!code) return { ok: false, reason: "invalid" };

  const codeHash = hashPassCode(code, requirePepper());

  // redeemed_code stores the plaintext for the ticket display — safe only
  // because a claimed code is inert (this UPDATE requires redeemed_by null)
  // and revocation is permanent. See migration 0040.
  const claimUpdate = {
    redeemed_by: userId,
    redeemed_at: new Date().toISOString(),
    redeemed_code: code,
  };
  let { data: claimed, error } = await client
    .from("founder_passes")
    .update(claimUpdate)
    .eq("code_hash", codeHash)
    .is("redeemed_by", null)
    .is("revoked_at", null)
    .select("serial")
    .maybeSingle();

  // Tolerate migration 0040 not being applied yet: a missing display column
  // must never brick redemption itself — a card that fails to redeem is a
  // support ticket, a ticket without its code on it is cosmetic.
  if (error && /redeemed_code/i.test(error.message)) {
    ({ data: claimed, error } = await client
      .from("founder_passes")
      .update({
        redeemed_by: claimUpdate.redeemed_by,
        redeemed_at: claimUpdate.redeemed_at,
      })
      .eq("code_hash", codeHash)
      .is("redeemed_by", null)
      .is("revoked_at", null)
      .select("serial")
      .maybeSingle());
  }

  if (claimed) return { ok: true, serial: (claimed as { serial: number }).serial };

  // The partial unique index on redeemed_by (migration 0039) is what stops one
  // account hoarding several cards. It surfaces here as a write conflict.
  if (error && /duplicate key|unique constraint/i.test(error.message)) {
    return { ok: false, reason: "already_have_pass" };
  }

  // The update matched nothing. Read the row back to say WHY. Only reached on
  // a failed claim, so it costs nothing on the happy path.
  //
  // This does confirm to the caller that a code is real-but-taken. Deliberate
  // trade: a consumed code grants nothing, and a holder whose card was already
  // claimed needs to be told that rather than stonewalled with "invalid". The
  // rate limiter above is what stops this being a usable probe oracle.
  const { data: existing } = await client
    .from("founder_passes")
    .select("redeemed_by, revoked_at")
    .eq("code_hash", codeHash)
    .maybeSingle();

  if (!existing) return { ok: false, reason: "invalid" };
  const row = existing as { redeemed_by: string | null; revoked_at: string | null };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.redeemed_by) return { ok: false, reason: "already_redeemed" };
  return { ok: false, reason: "invalid" };
}

/** The live pass held by a user, or null. Revoked passes read as null. */
export async function getPassForUser(
  client: SupabaseClient,
  userId: string,
): Promise<FounderPass | null> {
  // select("*") rather than naming columns: naming redeemed_code would make
  // this read ERROR (and every holder's pass silently vanish, since callers
  // only see null) on a database where migration 0040 hasn't run yet.
  const { data } = await client
    .from("founder_passes")
    .select("*")
    .eq("redeemed_by", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (!data) return null;
  const row = data as PassRow;
  return {
    serial: row.serial,
    redeemedAt: row.redeemed_at,
    batch: row.batch,
    redeemedCode: row.redeemed_code ?? null,
    profile: mapPassProfile(row),
  };
}

export { mapPassProfile };

export async function hasFounderPass(
  client: SupabaseClient,
  userId: string,
): Promise<boolean> {
  return (await getPassForUser(client, userId)) !== null;
}

/**
 * Whether this user may apply while the public applications gate is closed.
 *
 * Two conditions, both required: the admin has opened the early-access window
 * (`founder_pass_early_access`), AND the user holds a live pass. The setting
 * exists because `applications_open` can't distinguish "not open to the public
 * yet" from "closed for good" — see supabase/migrations/0039_founder_passes.sql.
 *
 * Fails CLOSED at every branch. This function's only job is to hand someone a
 * way past a gate the public can't pass, so "we couldn't tell" must resolve to
 * "no" — including when the setting row is missing entirely, which is why the
 * check is `=== true` rather than `!== false` (the inverse of how
 * applications_open itself is read, and deliberately so).
 */
export async function canBypassClosedApplications(
  client: SupabaseClient,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await client
    .from("site_settings")
    .select("value")
    .eq("key", "founder_pass_early_access")
    .maybeSingle();
  if (error) return false;
  if (data?.value !== true) return false;
  return hasFounderPass(client, userId);
}

/**
 * Every user holding a live pass.
 *
 * Returned as a Set so the admin review queue can badge rows without an N+1,
 * mirroring how lib/referrals.ts resolveReferrersByCode() serves the referral
 * badge on the same page.
 */
export async function passHolderUserIds(
  client: SupabaseClient,
): Promise<Set<string>> {
  const { data } = await client
    .from("founder_passes")
    .select("redeemed_by")
    .not("redeemed_by", "is", null)
    .is("revoked_at", null);
  const out = new Set<string>();
  for (const r of (data ?? []) as Array<{ redeemed_by: string | null }>) {
    if (r.redeemed_by) out.add(r.redeemed_by);
  }
  return out;
}
