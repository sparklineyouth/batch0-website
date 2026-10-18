// ---------------------------------------------------------------------------
// The provider webhook's URL, in the two forms that matter.
//
// Twilio does NOT retry a webhook that answered 5xx unless it is told to. Its
// default retry policy is `rp=ct` — one retry, on a connection timeout only —
// so a 500 from app/api/webhooks/sms is logged on Twilio's side as error 11200
// and dropped. The route answers 500 when an opt-out can't be written precisely
// so the request comes back; without an override that request never does.
//
// The override is a URL fragment ("connection override"), which Twilio reads
// and strips: it is never sent to us and is not part of the string Twilio
// signs. So there are two URLs, and mixing them up breaks one thing each:
//
//   signed   what X-Twilio-Signature is computed over, and what the route
//            verifies against. No fragment.
//   console  what goes in the Twilio console and in each message's
//            StatusCallback. The signed URL plus the retry override.
//
// `rp=ct,5xx` keeps the default connection-timeout retry and adds 5xx; `rc=3`
// is three retries (Twilio allows 0–5). Not 4xx: a 403 is a bad signature,
// and retrying it changes nothing. Not `rt`: a read timeout can mean the write
// landed, and a redelivered STOP is harmless but a redelivered START or
// question is a second reply. The drain's reconcile pass (lib/sms/queue.ts) is
// the safety net for a revocation that still never lands.
//
// Import-free, so the tests and the settings page read the same strings.
// ---------------------------------------------------------------------------

export const SMS_WEBHOOK_PATH = "/api/webhooks/sms";

/** Twilio's connection-override fragment, without the leading "#". */
export const TWILIO_RETRY_OVERRIDE = "rp=ct,5xx&rc=3";

/** What Twilio signs, and what the route verifies the signature against. */
export function smsWebhookSignedUrl(siteUrl: string): string {
  return `${siteUrl}${SMS_WEBHOOK_PATH}`;
}

/** What goes in the console and in StatusCallback: the signed URL, plus retries. */
export function smsWebhookConsoleUrl(siteUrl: string): string {
  return `${smsWebhookSignedUrl(siteUrl)}#${TWILIO_RETRY_OVERRIDE}`;
}
