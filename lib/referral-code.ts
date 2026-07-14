// Shared referral-code capture helpers for the signup/login/apply funnel.
//
// A referred visitor lands on /apply?ref=CODE. The middleware bounces a
// logged-out visitor to /signup (or /login) with the original path nested
// in ?next, so on the auth pages the code lives inside `next` rather than
// as a top-level ?ref. We stash it in localStorage as a safety net in case
// the URL query is ever lost across the round-trip, and the apply form
// reads it back on mount. Keep the storage key in one place so the writers
// (auth forms) and the reader (apply form) can never drift.

export const REF_STORAGE_KEY = "batch0_ref";

/**
 * Extract a referral code from the current browser location: a top-level
 * `?ref`, or one nested inside a relative `?next` path (the shape the auth
 * bounce produces). Returns "" when absent or on the server.
 */
export function readRefFromLocation(): string {
  if (typeof window === "undefined") return "";
  try {
    const params = new URL(window.location.href).searchParams;
    let ref = params.get("ref");
    if (!ref) {
      const nextParam = params.get("next");
      if (nextParam) {
        // `next` is a relative path like "/apply?ref=CODE"; resolve it
        // against the current origin to read its own query string.
        ref = new URL(nextParam, window.location.origin).searchParams.get(
          "ref",
        );
      }
    }
    return (ref ?? "").slice(0, 32);
  } catch {
    return "";
  }
}

/** Capture the referral code from the URL into localStorage, if present. */
export function stashRefFromLocation(): void {
  const ref = readRefFromLocation();
  if (!ref) return;
  try {
    window.localStorage.setItem(REF_STORAGE_KEY, ref);
  } catch {}
}
