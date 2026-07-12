import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  rowToChallenge,
  HTTP_URL_RE,
  SHORT_TEXT_MAX,
  LONG_TEXT_MAX,
  URL_MAX,
  type Challenge,
  type ChallengeQuestion,
  type ChallengeAnswers,
  type PublicWinner,
} from "@/lib/challenges-shared";

// ---------------------------------------------------------------------------
// Weekly Challenges — SERVER data layer.
//
// This module holds everything that must run server-side: the runtime zod
// answer-schema builder and the service-role reads. Pure types/constants/
// helpers live in lib/challenges-shared.ts (client-safe) and are re-exported
// here so server callers can keep importing from "@/lib/challenges".
//
// Reads mirror getSiteConfig(): admin client with a no-store fetch, defensive
// parsing, and NEVER throw — a malformed row can degrade a challenge but can't
// crash the marquee or the apply page.
// ---------------------------------------------------------------------------

export * from "@/lib/challenges-shared";

/**
 * Build a zod schema for a submission from the challenge's question defs, so
 * validation always matches the exact questions rendered. Expects a record of
 * `{ [questionId]: string }` (missing keys should be pre-filled with "").
 */
export function buildAnswerSchema(
  questions: ChallengeQuestion[],
): z.ZodType<ChallengeAnswers> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const q of questions) {
    shape[q.id] = fieldSchema(q);
  }
  return z.object(shape) as unknown as z.ZodType<ChallengeAnswers>;
}

function fieldSchema(q: ChallengeQuestion): z.ZodTypeAny {
  const req = q.required;
  switch (q.type) {
    case "long_text": {
      const s = z.string().trim().max(LONG_TEXT_MAX, "That's too long");
      return req ? s.min(1, "Required") : s.optional().or(z.literal(""));
    }
    case "url": {
      const s = z
        .string()
        .trim()
        .max(URL_MAX, "That's too long")
        .refine(
          (v) => v === "" || HTTP_URL_RE.test(v),
          "Must be a full URL starting with http:// or https://",
        );
      return req
        ? s.refine((v) => v.length > 0, "Required")
        : s.optional().or(z.literal(""));
    }
    case "select": {
      const opts = q.options.length
        ? (q.options as [string, ...string[]])
        : (["__none__"] as [string, ...string[]]);
      const base = z.enum(opts);
      if (req) return base;
      return z.union([base, z.literal("")]);
    }
    case "short_text":
    default: {
      const s = z.string().trim().max(SHORT_TEXT_MAX, "That's too long");
      return req ? s.min(1, "Required") : s.optional().or(z.literal(""));
    }
  }
}

// --- Reads (service-role, no-store, never throw) --------------------------

/** The single active challenge (drives the hero marquee + apply page). */
export async function getActiveChallenge(): Promise<Challenge | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("challenges")
      .select("*")
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    return data ? rowToChallenge(data) : null;
  } catch (err) {
    console.error("[challenges] getActiveChallenge failed:", err);
    return null;
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

/** Curated, PII-safe funded winners for the public strip. */
export async function getPublicWinners(
  opts: { challengeSlug?: string; limit?: number } = {},
): Promise<PublicWinner[]> {
  try {
    const admin = createAdminClient();
    let q = admin
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
      fundedAt: r.funded_at ?? null,
    }));
  } catch (err) {
    console.error("[challenges] getPublicWinners failed:", err);
    return [];
  }
}
