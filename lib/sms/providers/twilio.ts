import { createHmac, timingSafeEqual } from "node:crypto";
import type { SmsSettings } from "@/lib/sms/settings";
import type { ProviderResult, SendArgs, SmsProvider } from "@/lib/sms/providers";

/**
 * Twilio over plain fetch, no SDK.
 *
 * The `twilio` npm package is ~5MB of client surface for two HTTP calls and a
 * signature check, and it pulls its own request stack into a bundle that already
 * ships to serverless functions with a cold-start budget. The REST API is
 * form-encoded POST with basic auth; writing it out is a dozen lines and removes
 * a dependency from the critical path of sending a message.
 */

const API_BASE = "https://api.twilio.com/2010-04-01";

/**
 * Twilio error codes that mean "this will never work, stop trying".
 *
 * Getting this list right is the difference between a retry ladder that fixes
 * transient carrier congestion and one that bills us four times to deliver
 * nothing to a landline. Anything not listed here is treated as retryable, which
 * is the safe direction: a wrongly-retried permanent failure costs three more
 * attempts, a wrongly-abandoned transient one loses a real message.
 *
 * 21610 is the interesting one — it means the recipient previously replied STOP
 * and Twilio is refusing on our behalf. It should never be reachable, because
 * lib/sms/consent.ts gates on our own suppression list first. If it ever fires,
 * our consent records and Twilio's have diverged, so the handler writes the
 * opt-out locally as well rather than just failing.
 */
const PERMANENT_ERROR_CODES = new Set([
  "21211", // invalid 'To' number
  "21214", // 'To' is not a mobile number
  "21408", // permission to send to this region is not enabled
  "21610", // recipient has unsubscribed (STOP)
  "21614", // 'To' is not a valid mobile number
  "30003", // unreachable destination handset
  "30004", // message blocked
  "30005", // unknown destination handset
  "30006", // landline or unreachable carrier
  "30007", // carrier violation — content filtered
  "30008", // unknown error, but Twilio classes it terminal for the message
  "60200", // invalid parameter
]);

/** Twilio's code for "the recipient has opted out", surfaced to the caller. */
export const TWILIO_UNSUBSCRIBED_CODE = "21610";

async function send(args: SendArgs, s: SmsSettings): Promise<ProviderResult> {
  if (!s.accountSid || !s.authToken) {
    return { ok: false, reason: "Twilio credentials are not configured.", retryable: false };
  }

  const form = new URLSearchParams({
    To: args.to,
    From: args.from,
    Body: args.body,
  });
  if (args.statusCallback) form.set("StatusCallback", args.statusCallback);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/Accounts/${s.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${s.accountSid}:${s.authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      // A hung connection must not hold a queue drain open until the function
      // times out — that would strand every row after this one in 'sending'.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    // Network-level failure: no message was accepted, so this is always safe to
    // retry.
    return {
      ok: false,
      reason: err?.name === "TimeoutError" ? "Twilio request timed out" : String(err?.message ?? err),
      retryable: true,
    };
  }

  const payload: any = await res.json().catch(() => null);

  if (!res.ok) {
    const code = payload?.code != null ? String(payload.code) : undefined;
    return {
      ok: false,
      reason: payload?.message ?? `Twilio returned ${res.status}`,
      errorCode: code,
      // 429 and 5xx are transient by definition; otherwise defer to the code
      // table, defaulting to retryable.
      retryable:
        res.status === 429 ||
        res.status >= 500 ||
        !(code && PERMANENT_ERROR_CODES.has(code)),
    };
  }

  const sid = payload?.sid;
  if (!sid) {
    return { ok: false, reason: "Twilio accepted the request but returned no SID", retryable: true };
  }
  return { ok: true, providerId: String(sid), status: payload?.status ?? undefined };
}

/**
 * Verify `X-Twilio-Signature`.
 *
 * Twilio's scheme: take the full request URL, append every POST parameter as
 * `key + value` in ASCII-sorted key order with no separators, HMAC-SHA1 that
 * with the auth token, base64 the digest.
 *
 * Two details that are easy to get wrong and silent when wrong:
 *
 *  - The URL must be exactly the one Twilio was configured with, including
 *    scheme, host and any query string. Behind Vercel's proxy `req.url` reports
 *    the internal host, so the caller passes the public URL explicitly rather
 *    than reconstructing it here.
 *  - Sorting is by raw key, not locale-aware. `Array.sort()` without a
 *    comparator is codepoint order, which is what Twilio uses.
 */
function verifyWebhook({
  url,
  params,
  signature,
  s,
}: {
  url: string;
  params: Record<string, string>;
  signature: string | null;
  s: SmsSettings;
}): boolean {
  if (!signature || !s.authToken) return false;

  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");

  const expected = createHmac("sha1", s.authToken).update(data, "utf8").digest("base64");

  // Constant-time compare. The lengths are attacker-visible either way, so an
  // early length check leaks nothing and avoids timingSafeEqual throwing on a
  // mismatched buffer size.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const twilioProvider: SmsProvider = { name: "twilio", send, verifyWebhook };

/**
 * Is this the code Twilio uses for "already unsubscribed"?
 *
 * Exported so the send path can reconcile: if Twilio knows about an opt-out we
 * don't, our own records are wrong and need the same row written.
 */
export function isUnsubscribedCode(code: string | undefined): boolean {
  return code === TWILIO_UNSUBSCRIBED_CODE;
}
