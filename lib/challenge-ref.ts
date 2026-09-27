// Per-challenge referral + join-intent memory, in the browser.
//
// Two things the challenge funnel has to remember across the signup round
// trip, both deliberately SCOPED to one challenge:
//
//  1. Whose link brought you here. lib/referral-code.ts keeps one global
//     "batch0_ref" for the cohort apply flow; reusing it for challenges meant
//     a friend who once opened B's link for challenge #1 was credited to B on
//     every later challenge they joined from the homepage — satisfying B's
//     referral gate week after week without anyone sharing anything. So a
//     challenge referral is stored under the challenge's slug and expires.
//
//  2. That you pressed Register while signed out. The event page finishes
//     that click after signup (?join=1). Without a marker set by the click
//     itself, ?join=1 alone would auto-register any signed-in student who
//     opened a crafted link — referral credit nobody chose to give.
//
// Every accessor tolerates storage being unavailable (private mode, webviews).

const REF_PREFIX = "batch0_ref_ch:";
const REF_MAX_AGE_MS = 30 * 24 * 3600_000;
const JOIN_KEY = "batch0_join_intent";
const JOIN_MAX_AGE_MS = 30 * 60_000;

export function challengeRefKey(slug: string): string {
  return REF_PREFIX + slug;
}

/** Remember a ?ref= from the current URL for this challenge. */
export function stashChallengeRef(slug: string): void {
  try {
    const code = new URL(window.location.href).searchParams.get("ref");
    if (!code) return;
    window.localStorage.setItem(
      challengeRefKey(slug),
      JSON.stringify({ code: code.slice(0, 32), at: Date.now() }),
    );
  } catch {}
}

/** The referral code stashed for THIS challenge, if recent. */
export function readChallengeRef(slug: string): string | null {
  try {
    const raw = window.localStorage.getItem(challengeRefKey(slug));
    if (!raw) return null;
    const v = JSON.parse(raw) as { code?: string; at?: number };
    if (!v.code || !v.at || Date.now() - v.at > REF_MAX_AGE_MS) return null;
    return v.code;
  } catch {
    return null;
  }
}

export function clearChallengeRef(slug: string): void {
  try {
    window.localStorage.removeItem(challengeRefKey(slug));
  } catch {}
}

/** Set by the Register / Sign in clicks right before leaving for auth. */
export function markJoinIntent(slug: string): void {
  try {
    window.localStorage.setItem(JOIN_KEY, JSON.stringify({ slug, at: Date.now() }));
  } catch {}
}

/** True (once) when this visit is the return from a Register click. */
export function consumeJoinIntent(slug: string): boolean {
  try {
    const raw = window.localStorage.getItem(JOIN_KEY);
    if (!raw) return false;
    window.localStorage.removeItem(JOIN_KEY);
    const v = JSON.parse(raw) as { slug?: string; at?: number };
    return v.slug === slug && !!v.at && Date.now() - v.at < JOIN_MAX_AGE_MS;
  } catch {
    return false;
  }
}
