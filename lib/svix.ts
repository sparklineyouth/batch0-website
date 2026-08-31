import crypto from "node:crypto";

/**
 * Svix webhook signature verification.
 *
 * Resend (and several other providers) deliver webhooks through Svix, which
 * signs each request with an HMAC over the message id, the timestamp, and the
 * exact request body.
 *
 * Extracted from app/api/resend/webhook/route.ts so it can be tested. It is
 * the single check standing between "anyone on the internet" and a
 * service-role INSERT into `email_events`, and a signature verifier that is
 * subtly wrong fails in the worst possible direction — it keeps accepting
 * traffic and nobody notices. Route handlers can't be exercised by
 * `node --test`, so while it lived there it was never actually run against a
 * known-good signature.
 *
 * Import-free apart from node:crypto, so the test can load it directly.
 *
 * Spec: https://docs.svix.com/receiving/verifying-payloads/how-manual
 */

/** How far a request's timestamp may be from now. Svix's own recommendation. */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type SvixHeaders = {
  id: string;
  timestamp: string;
  signature: string;
};

/** The exact bytes the HMAC is computed over. */
export function svixSignedContent(
  headers: Pick<SvixHeaders, "id" | "timestamp">,
  rawBody: string,
): string {
  return `${headers.id}.${headers.timestamp}.${rawBody}`;
}

/**
 * The expected `v1` signature for a payload, base64.
 *
 * The secret arrives as `whsec_<base64>`; the bytes that key the HMAC are the
 * base64-decoded remainder, NOT the string itself. Signing with the raw string
 * is the classic way to get a verifier that rejects every legitimate request.
 */
export function svixSign(
  secret: string,
  headers: Pick<SvixHeaders, "id" | "timestamp">,
  rawBody: string,
): string {
  const cleaned = secret.startsWith("whsec_")
    ? secret.slice("whsec_".length)
    : secret;
  return crypto
    .createHmac("sha256", Buffer.from(cleaned, "base64"))
    .update(svixSignedContent(headers, rawBody))
    .digest("base64");
}

/**
 * Does the request carry a valid signature?
 *
 * The `svix-signature` header may list several space-separated signatures
 * (`v1,<sig> v1,<sig2>`) — that's how Svix rotates secrets, so a receiver that
 * only checks the first one breaks during a rotation. Any match is a pass.
 *
 * Compared with `timingSafeEqual`. The length pre-check is required (it throws
 * on a length mismatch) and leaks only the length, which is fixed for SHA-256.
 */
export function verifySvixSignature(args: {
  secret: string;
  headers: SvixHeaders;
  rawBody: string;
}): boolean {
  let expected: string;
  try {
    expected = svixSign(args.secret, args.headers, args.rawBody);
  } catch {
    return false;
  }
  const expectedBuf = Buffer.from(expected, "utf8");

  for (const part of args.headers.signature.split(" ")) {
    // Only `v1` is defined today; ignore anything else rather than trying to
    // verify a scheme we don't implement.
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const candidate = Buffer.from(sig, "utf8");
    if (
      candidate.length === expectedBuf.length &&
      crypto.timingSafeEqual(candidate, expectedBuf)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Is the timestamp recent enough to accept?
 *
 * Guards replay: a signature stays valid forever, so without a window a
 * captured request could be resent indefinitely.
 */
export function isFreshTimestamp(
  timestamp: string,
  nowMs: number = Date.now(),
): boolean {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(nowMs / 1000 - seconds) <= SVIX_TOLERANCE_SECONDS;
}
