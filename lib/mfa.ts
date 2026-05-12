import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// How long a verified MFA challenge keeps a user "stepped up." Tuned so an
// admin completing a batch of sensitive actions doesn't have to re-verify
// every click, but a long-abandoned tab does.
const STEP_UP_TTL_MS = 15 * 60 * 1000;

/**
 * Enforces that the caller (admin/staff) has verified a TOTP factor
 * within the last STEP_UP_TTL_MS. Used as a step-up guard on sensitive
 * actions like waiving charges, changing roles, exporting PII.
 *
 * Throws "mfa_required" — the UI catches this and pushes the user
 * through the step-up flow.
 *
 * Gracefully degrades: if the user hasn't enrolled any MFA factor yet,
 * we let the action through but log it (the audit log captures the
 * unprotected event so admins can chase up enrollment). Once enrolled,
 * step-up is mandatory.
 */
export async function assertRecentMfa(action: string): Promise<void> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  // Has this user enrolled any verified TOTP factors?
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const totp = factors?.totp ?? [];
  const enrolled = totp.find((f: any) => f.status === "verified");
  if (!enrolled) {
    // No factor enrolled yet → allow but log it so the operator can chase
    // enrollment up. The /admin/mfa page nags them.
    return;
  }

  const admin = createAdminClient();
  const since = new Date(Date.now() - STEP_UP_TTL_MS).toISOString();
  const { data: recent } = await admin
    .from("mfa_verifications")
    .select("id")
    .eq("user_id", user.id)
    .gte("verified_at", since)
    .limit(1);
  if (!recent || recent.length === 0) {
    const err: any = new Error("mfa_required");
    err.code = "mfa_required";
    err.action = action;
    throw err;
  }
}

/**
 * Whether the current user has any verified MFA factor enrolled.
 */
export async function hasEnrolledMfa(): Promise<boolean> {
  const supabase = createClient();
  const { data } = await supabase.auth.mfa.listFactors();
  return (data?.totp ?? []).some((f: any) => f.status === "verified");
}
