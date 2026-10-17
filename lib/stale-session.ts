// ---------------------------------------------------------------------------
// What a failed session check in middleware means, and whether to log it.
//
// Import-free, so `node --test` runs it as-is and the edge middleware can
// import it without pulling in anything else.
// ---------------------------------------------------------------------------

/**
 * Auth error codes that mean the session in the visitor's cookie is gone for
 * good: the refresh token was revoked or rotated away (signed out on another
 * device, "sign out everywhere", a password change), the session row was
 * deleted or timed out, or the user no longer exists.
 *
 * This is the ordinary end of a session, not an incident. Someone who signed
 * in weeks ago and comes back with the old cookie hits it on their first
 * request, and so does every prefetch and image request that page fires in
 * parallel — which is why one returning visitor used to put a burst of
 * `refresh_token_not_found` lines into the production error log (2026-10-13:
 * /apply, /api/promo and /opengraph-image in the same second, each logged by
 * the middleware and again by auth-js).
 *
 * Deliberately NOT here: `refresh_token_already_used`. That one is a rotation
 * race this app causes itself when a page and its prefetches refresh together,
 * and the visitor is usually still signed in through whichever request won.
 */
export const STALE_SESSION_CODES: ReadonlySet<string> = new Set([
  "refresh_token_not_found",
  "session_not_found",
  "session_expired",
  "user_not_found",
]);

type AuthLikeError = { __isAuthError?: unknown; code?: unknown; status?: unknown };

/**
 * An auth-js error whose code says the session is over. Matches on the
 * `__isAuthError` brand auth-js puts on every error it raises, not on
 * `instanceof`: the class names are minified in the edge bundle (production
 * logs show them as `Sa` and `Ea`), and nothing here should depend on which
 * copy of the library constructed the error.
 */
export function isStaleSessionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as AuthLikeError;
  return e.__isAuthError === true && typeof e.code === "string" && STALE_SESSION_CODES.has(e.code);
}

/**
 * What middleware should make of the `error` getClaims() returned.
 *
 *  - "signed-out": the session is over (see STALE_SESSION_CODES). The visitor
 *    is treated as signed out and their dead cookie is expired. Expected, so
 *    it is not logged.
 *  - "rejected": the server refused the token itself (401/403). Also signed
 *    out and expired, but unusual enough to keep logging.
 *  - "transient": anything else — the JWKS fetch failing on a cold isolate, a
 *    GoTrue 5xx, a refresh race, an error nobody has seen before. The cookie
 *    is left alone (it is probably fine) and the failure is logged, because
 *    an unexpected auth failure is exactly what the log is for.
 */
export type ClaimsFailure = "signed-out" | "rejected" | "transient";

export function classifyClaimsError(err: unknown): ClaimsFailure {
  if (isStaleSessionError(err)) return "signed-out";
  const status = err && typeof err === "object" ? (err as AuthLikeError).status : undefined;
  if (status === 401 || status === 403) return "rejected";
  return "transient";
}

const QUIETED = Symbol.for("batch0.quiet-stale-session-logs");

type ErrorSink = { error: (...args: any[]) => void };

/**
 * Drop auth-js's own log line for a session that has simply ended, and pass
 * everything else through untouched.
 *
 * auth-js logs that case itself, with a bare `console.error(err)`, from
 * inside the client: every Supabase client registers an auth-state listener
 * (supabase-js one, @supabase/ssr another), each listener's INITIAL_SESSION
 * emission loads the session, and a load that fails prints the error. Nothing
 * in the client's options turns that off, and it happens on a code path the
 * middleware never calls directly, so the only place to stop the noise is the
 * sink it writes to.
 *
 * The filter is as narrow as it can be: exactly one argument, and that
 * argument an auth error with a STALE_SESSION_CODES code — the precise shape
 * of that one call. Our own log lines always lead with a string tag, so they
 * never match; neither does any other error, from auth-js or anywhere else.
 * Idempotent, so a module evaluated twice in one isolate does not stack two
 * wrappers.
 */
export function quietStaleSessionLogs(sink: ErrorSink): void {
  const flagged = sink as ErrorSink & { [QUIETED]?: true };
  if (flagged[QUIETED]) return;
  const original = sink.error;
  sink.error = function (this: unknown, ...args: unknown[]) {
    if (args.length === 1 && isStaleSessionError(args[0])) return;
    return original.apply(this, args);
  };
  flagged[QUIETED] = true;
}
