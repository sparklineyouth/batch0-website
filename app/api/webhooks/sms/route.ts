import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { maskE164, normalizeToE164 } from "@/lib/phone";
import { getSmsSettings } from "@/lib/sms/settings";
import { providerFor } from "@/lib/sms/providers";
import { MAX_ATTEMPTS } from "@/lib/sms/queue";
import { stopShouldBeRecorded, type ConsentRow } from "@/lib/sms/consent-rules";
import { isOptOutRequest } from "@/lib/sms/keywords";
import { smsWebhookSignedUrl } from "@/lib/sms/webhook-url";
import {
  classifyInbound,
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
 *   * A failed write returns 500 so the provider RETRIES — which Twilio only
 *     does because the URL in its console carries a retry override
 *     (`#rp=ct,5xx&rc=3`, lib/sms/webhook-url.ts). By default Twilio drops a
 *     5xx after logging it. Returning 200 on a failed opt-out would make it
 *     drop the request even with the override. And because a retry can fail
 *     too, the drain re-reads the inbound log and records any opt-out still
 *     missing from the ledger (reconcileOptOuts in lib/sms/queue.ts) — the
 *     inbound text is logged first, below, for exactly that.
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

/**
 * How long a number goes between "not monitored" replies. Once a day: enough
 * to tell a person once, and it breaks the loop with a phone that answers every
 * text automatically ("I'm driving") — our reply would trigger theirs, theirs
 * ours, each one billed, until the carrier filtered the number.
 */
const UNMONITORED_REPLY_EVERY_HOURS = 24;

export async function POST(req: Request) {
  let settings = await getSmsSettings();

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
  // The retry override after `#` in the console URL is not part of what Twilio
  // signs, so it is not part of this either.
  const publicUrl = smsWebhookSignedUrl(env.siteUrl);
  const signature = req.headers.get("x-twilio-signature");
  const verify = (s: typeof settings) =>
    providerFor(s).verifyWebhook({ url: publicUrl, params, signature, s });
  let verified = verify(settings);
  if (!verified) {
    // Once more against the row itself rather than this instance's 30-second
    // cache: a token rotated at /admin/sms/settings in another instance would
    // otherwise 403 genuine requests until the cache expired, and Twilio
    // doesn't retry a 403 — a STOP in that window would be lost.
    const fresh = await getSmsSettings({ fresh: true });
    if (fresh.authToken && fresh.authToken !== settings.authToken) {
      settings = fresh;
      verified = verify(fresh);
    }
  }
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

    // Whether this number is already suppressed, and how. Read once, up front,
    // because three branches below turn on it. A failed read reads as "not
    // suppressed", which is the direction that still honours a STOP.
    const { data: consent } = await admin
      .from("messaging_consent")
      .select("opted_out_at, opted_out_source")
      .eq("phone_e164", from)
      .maybeSingle();
    const alreadyOptedOut = Boolean(consent?.opted_out_at);

    // An exact keyword, or a sentence that asks us to stop. Both are an opt-out
    // and both get the one confirmation the rule allows.
    if (isOptOutRequest(body)) {
      // A second STOP onto a STOP (or a carrier block, or a request an admin
      // recorded) changes nothing and gets nothing back: the rule allows ONE
      // confirmation, and it went out the first time. The message itself is
      // already logged in sms_events above.
      //
      // A STOP onto a dashboard opt-out is different, and is recorded: from the
      // phone, it locks the number the way any STOP does (a form can no longer
      // lift it), where the dashboard's own opt-out could be undone from the
      // dashboard. It gets the confirmation too — the dashboard confirmed on
      // screen, so no text has confirmed anything to this phone yet.
      if (alreadyOptedOut && !stopShouldBeRecorded(consent as ConsentRow | null)) {
        return noContent();
      }
      const result = await revokeConsent({
        phone: from,
        source: "sms_stop",
        inboundBody: body,
      });
      if (!result.ok) {
        // 500 so the provider retries (the console URL's override makes it).
        // If every retry fails too, the drain's reconcile pass records it
        // from the inbound log row written above.
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
    // Once a day per number, though: the inbound log is the record of what we
    // have already answered (every reply here is to an inbound text logged
    // above), so another text from this number in the window means it has
    // heard from us already. A failed read reads as "recently", because
    // silence costs nothing and a reply loop costs money.
    const since = new Date(Date.now() - UNMONITORED_REPLY_EVERY_HOURS * 3_600_000).toISOString();
    let earlier = admin
      .from("sms_events")
      .select("event_key")
      .eq("phone_e164", from)
      .eq("direction", "inbound")
      .gte("created_at", since);
    if (sid) earlier = earlier.neq("event_key", `${sid}:inbound`);
    const { data: recent, error: recentError } = await earlier.limit(1);
    if (recentError || (recent && recent.length > 0)) return noContent();

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
    // 500 so it is retried (StatusCallback carries the retry override, like the
    // console URL) — a lost receipt means a message stuck looking sent when
    // the carrier actually rejected it.
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
