import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { maskE164, normalizeToE164 } from "@/lib/phone";
import { getSmsSettings } from "@/lib/sms/settings";
import { providerFor } from "@/lib/sms/providers";
import { MAX_ATTEMPTS } from "@/lib/sms/queue";
import {
  classifyInbound,
  expressesRevocation,
  revokeConsent,
  restoreConsent,
  HELP_REPLY,
  OPT_OUT_REPLY,
  OPT_IN_REPLY,
  UNMONITORED_REPLY,
} from "@/lib/sms/consent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the provider sends back: delivery receipts AND inbound texts.
 *
 * One route for both because Twilio posts them in the same shape to whatever URL
 * you give it, and telling them apart is a one-line check on which fields are
 * present. Splitting them would mean two signature verifications and two places
 * for the URL to drift out of sync with the console.
 *
 * This is the most compliance-critical route in the codebase. A STOP that
 * arrives here and is not recorded is a violation of the revocation rule that
 * took effect April 11, 2025, with a ten-business-day honour window we would
 * blow through silently. So it is written to be as close to unbreakable as a
 * route can be:
 *
 *   * The opt-out is written BEFORE the reply is composed. If anything after the
 *     write throws, the person is already unsubscribed.
 *   * A failed write returns 500 so the provider RETRIES. Returning 200 on a
 *     failed opt-out would make the provider drop it, and the request that
 *     carried the revocation would be gone for good.
 *   * The STOP confirmation is sent back as TwiML in this response rather than
 *     through lib/sms/send.ts, which would refuse it — we just suppressed the
 *     number. A confirmation of an opt-out is the one message you are required
 *     to send to someone who has opted out.
 *   * A request to stop in other words — "please stop texting me", "wrong
 *     number" — is an opt-out too (expressesRevocation in lib/sms/keywords.ts).
 *     The FCC rule counts any reasonable way of saying it, nobody reads this
 *     number to catch the ones a keyword table misses, and the privacy policy
 *     promises we honour them.
 *
 * The middleware never runs here (middleware.ts excludes the path): there is
 * no session to refresh on a provider's POST, and the signature below is the
 * only authentication this route has or needs.
 */

/**
 * The ONLY statuses that mean the carrier gave up. Allowlist, not denylist.
 *
 * This was originally written the other way round — "anything that isn't
 * `delivered` or `sent` is a failure" — which is a real and expensive bug, not a
 * style question. Twilio posts a receipt for every transition, and the FIRST one
 * for a normal message is `queued`. Under the inverted test that receipt flipped
 * a perfectly healthy outbox row to `failed`, the retry pass then moved it back
 * to `pending`, and the drain sent the same text again — repeating for as long
 * as the ladder allowed, to a real person's phone.
 *
 * So the rule is: a status has to be explicitly known-terminal to touch the
 * outbox. Everything else (`accepted`, `scheduled`, `queued`, `sending`,
 * `delivered`, `sent`, and anything Twilio adds later) is recorded as an event
 * and otherwise ignored.
 */
const TERMINAL_FAILURE = new Set(["failed", "undelivered", "canceled"]);

function twiml(body: string): Response {
  // Escaped because a reply is assembled from constants today, and the first
  // time someone interpolates a name into one it must not be able to close the
  // tag.
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`,
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}

const noContent = () => new Response(null, { status: 204 });

export async function POST(req: Request) {
  const settings = await getSmsSettings();

  // Refuse before parsing anything when we have no key to verify with. An
  // unauthenticated endpoint here lets anyone on the internet suppress our
  // messaging to any number they choose, and mark unsent messages as delivered.
  if (!settings.authToken) {
    console.error("[webhooks/sms] no auth token configured — refusing unverifiable request");
    return new Response("Not configured", { status: 503 });
  }

  const raw = await req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;

  // The URL Twilio signed is the PUBLIC one it was configured with. Behind
  // Vercel's proxy `req.url` reports an internal host, so it is reconstructed
  // from siteUrl — which must match the console entry exactly, including scheme.
  const publicUrl = `${env.siteUrl}/api/webhooks/sms`;
  const provider = providerFor(settings);
  const verified = provider.verifyWebhook({
    url: publicUrl,
    params,
    signature: req.headers.get("x-twilio-signature"),
    s: settings,
  });
  if (!verified) {
    console.error("[webhooks/sms] signature verification failed");
    return new Response("Invalid signature", { status: 403 });
  }

  const admin = createAdminClient();

  // ---- Inbound text ------------------------------------------------------
  // An inbound message carries a Body; a status callback does not.
  if (typeof params.Body === "string" && params.From) {
    const from = normalizeToE164(params.From);
    const body = params.Body ?? "";
    const sid = params.MessageSid ?? params.SmsSid ?? "";

    // Log it first, so even a message nothing below acts on is on record in
    // sms_events. Keyed on SID + direction so a redelivery writes one row.
    if (sid) {
      await admin
        .from("sms_events")
        .upsert(
          {
            event_key: `${sid}:inbound`,
            provider_id: sid,
            phone_e164: from,
            direction: "inbound",
            status: "received",
            body,
          },
          { onConflict: "event_key" },
        )
        .then(({ error }) => {
          if (error) console.error("[webhooks/sms] inbound log failed", error.message);
        });
    }

    if (!from) {
      // Can't act on a number we can't normalize, and can't silently drop it
      // either — the log row above is the record.
      return noContent();
    }

    const intent = classifyInbound(body);

    // Whether this number is already suppressed. Read once, up front, because
    // two branches below turn on it. A failed read reads as "not suppressed",
    // which is the direction that still honours a STOP.
    const { data: consent } = await admin
      .from("messaging_consent")
      .select("opted_out_at")
      .eq("phone_e164", from)
      .maybeSingle();
    const alreadyOptedOut = Boolean(consent?.opted_out_at);

    // An exact keyword, or a sentence that asks us to stop. Both are an opt-out
    // and both get the one confirmation the rule allows.
    if (intent === "stop" || (intent === "other" && expressesRevocation(body))) {
      // A second STOP from a number that already opted out changes nothing and
      // gets nothing back: the rule allows ONE confirmation, and it went out the
      // first time. The message itself is already logged in sms_events above.
      if (alreadyOptedOut) return noContent();
      const result = await revokeConsent({
        phone: from,
        source: "sms_stop",
        inboundBody: body,
      });
      if (!result.ok) {
        // 500 so the provider retries. Losing this request loses the opt-out.
        console.error("[webhooks/sms] OPT-OUT WRITE FAILED", result.error);
        return new Response("Could not record opt-out", { status: 500 });
      }
      // revokeConsent also cancelled anything still queued to this number.
      return twiml(OPT_OUT_REPLY);
    }

    if (intent === "start") {
      const result = await restoreConsent({ phone: from, inboundBody: body });
      // A START from a number with nothing to restore is answered with HELP
      // rather than silence — it is almost always someone confused, and
      // subscribing them off one word would be its own complaint.
      return twiml(result.ok ? OPT_IN_REPLY : HELP_REPLY);
    }

    if (intent === "help") {
      // Always answered, even for a suppressed number. HELP is a carrier-required
      // keyword and its reply carries only the brand, the contact and the opt-out
      // instruction — refusing to answer it is the violation, not answering it.
      return twiml(HELP_REPLY);
    }

    // Everything below here is a message WE chose to send, so it has to respect
    // the suppression list. A number that replied STOP and then texts something
    // conversational must get silence: the one message you are allowed to send
    // after an opt-out is the confirmation of that opt-out, which already went
    // out when they opted out.
    if (alreadyOptedOut) return noContent();

    // Anything else is a human trying to talk to us. Nobody is watching this
    // number, so saying so is the only honest reply — a silent drop reads as
    // "they ignored me", and the program's actual support channel is email.
    return twiml(UNMONITORED_REPLY);
  }

  // ---- Delivery receipt --------------------------------------------------
  const sid = params.MessageSid ?? params.SmsSid;
  const status = params.MessageStatus ?? params.SmsStatus;
  if (!sid || !status) return noContent();

  const errorCode = params.ErrorCode || null;

  const { error: eventError } = await admin.from("sms_events").upsert(
    {
      // SID + status, because one message emits several receipts (queued → sent
      // → delivered) all carrying the same SID. Keying on SID alone would keep
      // only the first and lose the outcome.
      event_key: `${sid}:${status}`,
      provider_id: sid,
      phone_e164: normalizeToE164(params.To ?? "") ?? null,
      direction: "outbound",
      status,
      error_code: errorCode,
    },
    { onConflict: "event_key" },
  );
  if (eventError) {
    console.error("[webhooks/sms] receipt write failed", eventError.message);
    // 500 so it is retried — a lost receipt means a message stuck looking sent
    // when the carrier actually rejected it.
    return new Response("Could not record event", { status: 500 });
  }

  // Reflect a terminal carrier failure onto the outbox row. Twilio's REST call
  // succeeded at send time, so without this a message the carrier refused
  // reads as `sent` forever.
  //
  // `attempts` is pushed to the cap in the same statement. A row failed by a
  // webhook rather than by the drain has never been through `finish()`, so its
  // attempt counter is whatever the send left it at — and the retry pass only
  // looks at `attempts < MAX_ATTEMPTS`. Without this the carrier's "I will never
  // deliver this" becomes an instruction to try again.
  if (TERMINAL_FAILURE.has(status)) {
    await admin
      .from("sms_outbox")
      .update({
        status: "failed",
        last_error: `Carrier reported ${status}${errorCode ? ` (${errorCode})` : ""}`,
        attempts: MAX_ATTEMPTS,
        updated_at: new Date().toISOString(),
      })
      .eq("provider_id", sid)
      // Only a row we believed had succeeded. A row already `failed` keeps its
      // original, more specific reason.
      .eq("status", "sent");
  }

  // 21610 arriving as a receipt means the carrier suppressed the number and our
  // records disagree. Same reconciliation the send path does.
  if (errorCode === "21610") {
    const to = normalizeToE164(params.To ?? "");
    if (to) {
      const suppressed = await revokeConsent({
        phone: to,
        source: "provider_21610",
        inboundBody: "Carrier reported the number as unsubscribed on a delivery receipt.",
      });
      if (!suppressed.ok) {
        // 500 so the receipt is redelivered. This is the carrier telling us
        // somebody opted out through a channel we never saw; dropping it leaves
        // the number opted-in in our records, and every later campaign re-sends
        // to a number the carrier is already blocking.
        console.error("[webhooks/sms] SUPPRESSION WRITE FAILED for 21610", maskE164(to), suppressed.error);
        return new Response("Could not record carrier suppression", { status: 500 });
      }
    }
  }

  return noContent();
}
