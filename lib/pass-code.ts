// Client-side capture for a founder pass code, so it survives the signup
// round-trip.
//
// Deliberately parallel to lib/referral-code.ts rather than folded into it:
// the two codes look similar but must never mix. A referral code identifies
// the person who SENT you; a pass code is a bearer token for a physical card.
// Sharing one storage key would let a stale value from one funnel be redeemed
// as the other.
//
// The flow this supports: /pass is public, so someone holding a card can type
// the code before they have an account. On submit while signed out we stash
// the code here and bounce through /signup?next=/pass; on the way back the
// form reads it, redeems it, and clears it. A card may also carry a QR to
// /pass?code=XXXX, which the same helpers pick up.
//
// Keep the storage key in this one place so the writer and the reader can
// never drift.

export const PASS_STORAGE_KEY = "batch0_pass_code";

/** Read a pass code from `?code`, or from one nested in a relative `?next`. */
export function readPassCodeFromLocation(): string {
  if (typeof window === "undefined") return "";
  try {
    const params = new URL(window.location.href).searchParams;
    let code = params.get("code");
    if (!code) {
      const nextParam = params.get("next");
      if (nextParam) {
        // `next` is a relative path like "/pass?code=XXXX"; resolve it against
        // the current origin to read its own query string.
        code = new URL(nextParam, window.location.origin).searchParams.get("code");
      }
    }
    return (code ?? "").slice(0, 64);
  } catch {
    return "";
  }
}

export function stashPassCode(code: string): void {
  if (!code) return;
  try {
    window.localStorage.setItem(PASS_STORAGE_KEY, code.slice(0, 64));
  } catch {}
}

export function readStashedPassCode(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(PASS_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Clear the stashed code.
 *
 * Called after ANY terminal outcome, success or failure — not just success.
 * A code that stays in localStorage after a failed attempt would silently
 * re-fire on the next visit to /pass, which looks like the page redeeming
 * things by itself.
 */
export function clearStashedPassCode(): void {
  try {
    window.localStorage.removeItem(PASS_STORAGE_KEY);
  } catch {}
}
