import { createAdminClient } from "@/lib/supabase/admin";

function shortCode(): string {
  // 10-char alphanumeric, public-facing. Avoids confusing chars (O/0, I/1).
  const alpha = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 10; i++) {
    s += alpha[Math.floor(Math.random() * alpha.length)];
  }
  return s;
}

/**
 * Issues (or returns) a completion certificate for a user in a cohort.
 * Idempotent on (user_id, cohort_id). Caller is responsible for ensuring
 * the student actually finished the cohort.
 */
export async function issueCertificate(args: {
  userId: string;
  cohortId: string;
}): Promise<{ code: string; issued_at: string }> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("certificates")
    .select("code, issued_at")
    .eq("user_id", args.userId)
    .eq("cohort_id", args.cohortId)
    .maybeSingle();
  if (existing) return existing as any;

  for (let i = 0; i < 6; i++) {
    const code = shortCode();
    const { data, error } = await admin
      .from("certificates")
      .insert({
        user_id: args.userId,
        cohort_id: args.cohortId,
        code,
      })
      .select("code, issued_at")
      .single();
    if (!error && data) return data as any;
    // Retry on unique-collision (extremely unlikely with 32^10 space).
  }
  throw new Error("Failed to issue certificate.");
}
