/**
 * Client-side helper for surfacing server-action errors safely.
 *
 * Next.js sanitizes any Error thrown inside a server action when it
 * crosses the network boundary in production builds — the original
 * `error.message` is replaced with a fixed string that looks like:
 *
 *   "An error occurred in the Server Components render. The specific
 *    message is omitted in production builds to avoid leaking sensitive
 *    details. A digest property is included on this error instance which
 *    may provide additional details about the nature of the error."
 *
 * Showing that to a user as an inline form error is terrible UX. This
 * helper detects the stripped message and substitutes a friendly
 * fallback. For ideal UX, the underlying action should return an
 * `ActionResult` from `lib/action-result` instead of throwing — but for
 * the long tail of existing actions, masking the stripped string is the
 * minimal-touch fix.
 *
 * Also logs the original error to the browser console so it stays
 * available for in-DevTools debugging.
 */
export function getActionError(
  err: unknown,
  fallback = "Something went wrong. Please try again.",
): string {
  if (typeof window !== "undefined") {
    // Log full error client-side so devs / power users can see the
    // digest in the browser console even when the UI hides the
    // sanitized message.
    // eslint-disable-next-line no-console
    console.error("[action error]", err);
  }
  const message =
    err instanceof Error && err.message
      ? err.message
      : typeof err === "string"
        ? err
        : "";
  if (!message) return fallback;
  if (
    message.startsWith("An error occurred in the Server Components render") ||
    message.includes("digest property is included on this error")
  ) {
    return fallback;
  }
  return message;
}
