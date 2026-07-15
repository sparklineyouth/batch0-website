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

/** A pass as its holder sees it. */
export type FounderPass = {
  serial: number;
  redeemedAt: string | null;
  batch: string;
};

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

  const { data: claimed, error } = await client
    .from("founder_passes")
    .update({ redeemed_by: userId, redeemed_at: new Date().toISOString() })
    .eq("code_hash", codeHash)
    .is("redeemed_by", null)
    .is("revoked_at", null)
    .select("serial")
    .maybeSingle();

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
  const { data } = await client
    .from("founder_passes")
    .select("serial, redeemed_at, batch")
    .eq("redeemed_by", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (!data) return null;
  const row = data as {
    serial: number;
    redeemed_at: string | null;
    batch: string;
  };
  return { serial: row.serial, redeemedAt: row.redeemed_at, batch: row.batch };
}

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
